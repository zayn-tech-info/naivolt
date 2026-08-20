//! Funding — turning a card charge into a naira balance.
//!
//! ```text
//! credit   ngn_float     +5,000   (the money is ours to hold)
//!          user_ngn:{u}  -5,000   (and we owe the user that much)
//! ```
//!
//! Nothing is written to the ledger when an intent is created. The credit
//! happens on confirmation and exactly once, keyed on the provider's reference,
//! because a card that declines after we credited it is a balance the user may
//! already have spent.
//!
//! Verification is by polling rather than webhook. Paystack's verify endpoint is
//! authoritative and needs no signature handling, so there is no window where a
//! forged POST can credit an account. A webhook is the latency optimisation, not
//! the correctness mechanism, and can be added in front of this without changing
//! how the credit works.

use crate::error::{ApiError, ApiResult};
use crate::funding_provider::ChargeState;
use crate::middleware::CurrentUser;
use crate::payout_routes::{lock_user_ngn_account, platform_account};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use naivolt_core::Asset;
use naivolt_ledger::{AccountKind, JournalKind};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use uuid::Uuid;

/// Below this a card fee eats the whole deposit.
const MIN_FUNDING_NGN: i64 = 100;
/// A ceiling on a single unverified top-up. Not a KYC limit — those live in
/// `tier` and gate withdrawal, which is the direction money escapes.
const MAX_FUNDING_NGN: i64 = 1_000_000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/funding/intents", post(create_intent).get(list_intents))
        .route("/funding/intents/:id", get(get_intent))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIntentBody {
    pub amount_ngn: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentResponse {
    pub id: Uuid,
    pub reference: String,
    pub amount_ngn: String,
    pub status: String,
    /// Where to send the user to pay. Absent when the provider takes no money —
    /// the client reads that as "nothing to visit", not as a failure.
    pub authorization_url: Option<String>,
    /// True when a real card was charged rather than a stub confirming itself.
    pub live: bool,
    pub created_at: String,
}

async fn create_intent(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<CreateIntentBody>,
) -> ApiResult<Json<IntentResponse>> {
    let amount = Decimal::from_str(body.amount_ngn.trim())
        .map_err(|_| ApiError::BadRequest("That amount isn't a number.".into()))?;

    if amount < Decimal::from(MIN_FUNDING_NGN) {
        return Err(ApiError::BadRequest(format!(
            "The smallest top-up is ₦{MIN_FUNDING_NGN}."
        )));
    }
    if amount > Decimal::from(MAX_FUNDING_NGN) {
        return Err(ApiError::BadRequest(format!(
            "The largest single top-up is ₦{MAX_FUNDING_NGN}."
        )));
    }
    // Naira has kobo and nothing finer.
    if amount.scale() > 2 {
        return Err(ApiError::BadRequest("That amount is too precise.".into()));
    }

    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;

    // Paystack keys a transaction to an email and sends the receipt there.
    let email = email.ok_or_else(|| {
        ApiError::BadRequest("Add an email to your profile before funding.".into())
    })?;

    let reference = format!("NVFD-{}", &Uuid::new_v4().simple().to_string()[..12].to_uppercase());

    let (id, created_at): (Uuid, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO ngn_deposits (user_id, amount_ngn, provider, provider_reference)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at",
    )
    .bind(user.id)
    .bind(amount)
    .bind(if state.funding.is_live() { "paystack" } else { "stub" })
    .bind(&reference)
    .fetch_one(&state.db)
    .await?;

    // The row exists before the provider is called, so a charge that succeeds
    // while our response is lost still has somewhere to be reconciled to.
    let charge = state.funding.initialize(&email, amount, &reference).await?;

    Ok(Json(IntentResponse {
        id,
        reference,
        amount_ngn: amount.normalize().to_string(),
        status: "pending".into(),
        authorization_url: charge.authorization_url,
        live: state.funding.is_live(),
        created_at: created_at.to_rfc3339(),
    }))
}

/// Read an intent, asking the provider first if it is still open.
async fn get_intent(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<IntentResponse>> {
    let row: Option<(String, Decimal, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT status, amount_ngn, provider_reference, created_at
           FROM ngn_deposits WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;

    let (status, amount, reference, created_at) = row.ok_or(ApiError::NotFound)?;

    let status = if status == "pending" {
        match state.funding.verify(&reference, amount).await {
            Ok(ChargeState::Succeeded { amount_ngn }) => {
                credit_deposit(&state, id, user.id, &reference, amount_ngn).await?;
                "succeeded".to_owned()
            }
            Ok(ChargeState::Failed { reason }) => {
                sqlx::query(
                    "UPDATE ngn_deposits SET status = 'failed', failure_reason = $2,
                            updated_at = now()
                      WHERE id = $1 AND status = 'pending'",
                )
                .bind(id)
                .bind(&reason)
                .execute(&state.db)
                .await?;
                "failed".to_owned()
            }
            Ok(ChargeState::Pending) => status,
            // A provider we cannot reach is not a failed payment. The intent
            // stays open and the next read asks again.
            Err(e) => {
                tracing::warn!(error = %e, intent = %id, "funding verify failed");
                status
            }
        }
    } else {
        status
    };

    Ok(Json(IntentResponse {
        id,
        reference,
        amount_ngn: amount.normalize().to_string(),
        status,
        authorization_url: None,
        live: state.funding.is_live(),
        created_at: created_at.to_rfc3339(),
    }))
}

async fn list_intents(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<IntentResponse>>> {
    let rows: Vec<(Uuid, String, Decimal, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, provider_reference, amount_ngn, status, created_at
           FROM ngn_deposits WHERE user_id = $1
          ORDER BY created_at DESC LIMIT 50",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    let live = state.funding.is_live();
    Ok(Json(
        rows.into_iter()
            .map(|(id, reference, amount_ngn, status, created_at)| IntentResponse {
                id,
                reference,
                amount_ngn: amount_ngn.normalize().to_string(),
                status,
                authorization_url: None,
                live,
                created_at: created_at.to_rfc3339(),
            })
            .collect(),
    ))
}

/// Credit a confirmed charge. Safe to call twice.
async fn credit_deposit(
    state: &AppState,
    deposit_id: Uuid,
    user_id: Uuid,
    reference: &str,
    amount_ngn: Decimal,
) -> ApiResult<()> {
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;

    let ngn_account_id = lock_user_ngn_account(&mut tx, user_id).await?;
    let float_account_id = platform_account(&mut tx, AccountKind::NgnFloat).await?;

    let journal = naivolt_ledger::journal::JournalBuilder::new(
        JournalKind::NgnDeposit,
        reference.to_owned(),
        // The provider's reference is the idempotency key, so a webhook, a poll
        // and a manual replay of the same charge are one event, not three.
        format!("{reference}:credit"),
    )
    .entry(float_account_id, AccountKind::NgnFloat, Asset::Ngn, amount_ngn)
    .entry(ngn_account_id, AccountKind::UserNgn, Asset::Ngn, -amount_ngn)
    .build()
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    let outcome = journal
        .post(&mut tx)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    sqlx::query(
        "UPDATE ngn_deposits
            SET status = 'succeeded', amount_ngn = $2, credited_journal_id = $3,
                updated_at = now()
          WHERE id = $1 AND status = 'pending'",
    )
    .bind(deposit_id)
    .bind(amount_ngn)
    .bind(outcome.journal_id())
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(())
}
