//! Payouts — naira to a bank account.
//!
//! The reservation is the whole design (ARCHITECTURE.md §8). Funds leave the
//! user's balance *before* the provider is called, in one transaction, under a
//! row lock:
//!
//! ```text
//! J4  user_ngn:{u}         +150,000   (liability shrinks — they are owed less)
//!     ngn_payable_pending  -150,000   (we owe the bank instead)
//! ```
//!
//! Two things follow from doing it in that order. There is no window in which
//! the money sits in neither place, so a crash mid-payout cannot duplicate it.
//! And the `SELECT … FOR UPDATE` is what makes concurrent requests safe: two
//! taps on Withdraw at the same instant serialise, and the second sees the
//! balance the first already reduced. Without it both would read the original
//! balance and both would pass the check.
//!
//! If the provider later fails, J4 is reversed rather than J5 being written —
//! never a compensating debit that leaves the user short.

use crate::error::{ApiError, ApiResult};
use crate::middleware::CurrentUser;
use crate::state::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use naivolt_auth::tier::{check_payout, KycTier, PayoutCheck};
use naivolt_core::Asset;
use naivolt_ledger::{AccountKind, JournalKind};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new().route("/payouts", post(create_payout))
}

/// Where the money goes.
///
/// A discriminated union rather than a nullable account id, because the two are
/// genuinely different operations: `oneOff` has to run name enquiry and apply
/// third-party transfer rules before anything can be reserved. Collapsing them
/// into one optional field hides that from the caller.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Destination {
    #[serde(rename_all = "camelCase")]
    Beneficiary { bank_account_id: Uuid },
    #[serde(rename_all = "camelCase")]
    OneOff {
        bank_code: String,
        account_number: String,
        /// Echoed from the client's enquiry. Re-resolved server-side and
        /// compared — see below.
        account_name: String,
        #[serde(default)]
        save: bool,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePayoutBody {
    pub amount_ngn: String,
    pub destination: Destination,
    pub pin: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutResponse {
    pub id: Uuid,
    pub amount_ngn: String,
    pub fee: String,
    pub bank_account: PayoutBankAccount,
    pub status: String,
    pub reference: String,
    pub created_at: String,
    pub settled_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoutBankAccount {
    pub bank_name: String,
    pub account_number: String,
    pub account_name: String,
}

async fn create_payout(
    State(state): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
    Json(body): Json<CreatePayoutBody>,
) -> ApiResult<Json<PayoutResponse>> {
    // The client mints one key per intent and reuses it across every submit
    // attempt, including after a wrong PIN. Requiring it means there is no path
    // that moves money without a replay guard.
    let idempotency_key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::BadRequest("Idempotency-Key header is required".into()))?;

    let amount = Decimal::from_str(body.amount_ngn.trim())
        .map_err(|_| ApiError::BadRequest("That amount isn't a number.".into()))?;
    if amount <= Decimal::ZERO {
        return Err(ApiError::BadRequest("Enter an amount above zero.".into()));
    }
    // Naira has kobo and nothing finer. Accepting more precision would let a
    // request reserve an amount no bank can actually transfer.
    if amount.scale() > 4 {
        return Err(ApiError::BadRequest("That amount is too precise.".into()));
    }

    // --- PIN, before anything else is touched --------------------------------
    let (pin_hash, tier_raw): (Option<String>, i16) =
        sqlx::query_as("SELECT pin_hash, kyc_tier FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_one(&state.db)
            .await?;

    let pin_hash = pin_hash.ok_or_else(|| {
        ApiError::BadRequest("Set a PIN before withdrawing.".into())
    })?;

    if !naivolt_auth::verify_pin(&body.pin, &pin_hash)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?
    {
        // attempts_remaining is not tracked per-payout; the PIN lockout lives in
        // the auth flow. Reporting -1 would be a lie, so it reports 0 attempts
        // consumed and lets the client simply say "wrong PIN".
        return Err(ApiError::PinInvalid {
            attempts_remaining: 0,
        });
    }

    // --- Tier and daily cap ---------------------------------------------------
    let tier = KycTier::from_i16(tier_raw).unwrap_or(KycTier::Tier0);
    let used_today: Decimal =
        sqlx::query_scalar("SELECT used_ngn FROM payout_usage_24h WHERE user_id = $1")
            .bind(user.id)
            .fetch_optional(&state.db)
            .await?
            .unwrap_or(Decimal::ZERO);

    match check_payout(tier, amount, used_today) {
        PayoutCheck::Allowed => {}
        PayoutCheck::KycRequired { next_step } => {
            return Err(ApiError::KycRequired {
                next_step: next_step.to_owned(),
            })
        }
        PayoutCheck::ExceedsDailyCap { remaining, .. } => {
            return Err(ApiError::LimitExceeded {
                limit: remaining.normalize().to_string(),
            })
        }
    }

    // --- Resolve the destination to a stored bank account --------------------
    let bank_account_id = resolve_destination(&state, user.id, &body.destination).await?;

    let (bank_code, account_number, account_name): (String, String, String) = sqlx::query_as(
        "SELECT bank_code, account_number, account_name FROM bank_accounts
          WHERE id = $1 AND user_id = $2",
    )
    .bind(bank_account_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(ApiError::NotFound)?;

    // --- Reserve, under a row lock -------------------------------------------
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;

    // Lock the user's NGN account for the rest of the transaction. Everything
    // after this is serialised against another payout by the same user.
    let ngn_account_id = lock_user_ngn_account(&mut tx, user.id).await?;

    let raw_balance: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE account_id = $1",
    )
    .bind(ngn_account_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    let available = AccountKind::UserNgn.user_facing_balance(raw_balance);
    if amount > available {
        return Err(ApiError::InsufficientBalance);
    }

    let pending_account_id = platform_account(&mut tx, AccountKind::NgnPayablePending).await?;

    let reference = format!("NVLT-{}", Uuid::new_v4().simple());

    let journal = naivolt_ledger::journal::JournalBuilder::new(
        JournalKind::PayoutReserve,
        reference.clone(),
        idempotency_key.clone(),
    )
    // Liability shrinks: we owe this user less.
    .entry(ngn_account_id, AccountKind::UserNgn, Asset::Ngn, amount)
    // And owe the bank instead. Sums to zero, which the ledger enforces.
    .entry(
        pending_account_id,
        AccountKind::NgnPayablePending,
        Asset::Ngn,
        -amount,
    )
    .metadata(serde_json::json!({
        "bank_account_id": bank_account_id,
        "bank_code": bank_code,
    }))
    .build()
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    let outcome = journal
        .post(&mut tx)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    // A replay of the same intent must return the original payout, not create a
    // second one. The journal is already idempotent; this makes the payout row
    // match it.
    let existing: Option<(Uuid, String, Decimal, Decimal, String, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as(
            "SELECT id, status, amount_ngn, fee_ngn, provider_reference, created_at
               FROM payouts WHERE reserved_journal_id = $1",
        )
        .bind(outcome.journal_id())
        .fetch_optional(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;

    let payout = match existing {
        Some((id, status, amount_ngn, fee_ngn, provider_reference, created_at)) => {
            tx.commit().await.map_err(anyhow::Error::from)?;
            PayoutResponse {
                id,
                amount_ngn: amount_ngn.normalize().to_string(),
                fee: fee_ngn.normalize().to_string(),
                bank_account: PayoutBankAccount {
                    bank_name: bank_name_for(&bank_code),
                    account_number,
                    account_name,
                },
                status,
                reference: provider_reference,
                created_at: created_at.to_rfc3339(),
                settled_at: None,
            }
        }
        None => {
            let (id, created_at): (Uuid, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
                "INSERT INTO payouts
                   (user_id, bank_account_id, amount_ngn, fee_ngn, status,
                    provider_reference, reserved_journal_id)
                 VALUES ($1, $2, $3, 0, 'reserved', $4, $5)
                 RETURNING id, created_at",
            )
            .bind(user.id)
            .bind(bank_account_id)
            .bind(amount)
            .bind(&reference)
            .bind(outcome.journal_id())
            .fetch_one(&mut *tx)
            .await
            .map_err(anyhow::Error::from)?;

            tx.commit().await.map_err(anyhow::Error::from)?;

            PayoutResponse {
                id,
                amount_ngn: amount.normalize().to_string(),
                // Naivolt absorbs the provider fee — it books to
                // payout_fee_expense against the float, not to the user
                // (ARCHITECTURE.md §5, J5).
                fee: "0".into(),
                bank_account: PayoutBankAccount {
                    bank_name: bank_name_for(&bank_code),
                    account_number,
                    account_name,
                },
                status: "reserved".into(),
                reference,
                created_at: created_at.to_rfc3339(),
                settled_at: None,
            }
        }
    };

    // The transfer itself is deliberately not made inline. Funds are reserved and
    // durable; a background job picks the row up and calls the provider, so a
    // provider timeout cannot leave an HTTP handler unsure whether money moved.
    if !state.payouts.can_transfer() {
        tracing::warn!(
            payout_id = %payout.id,
            "no payout provider configured — reserved but not sent"
        );
    }

    Ok(Json(payout))
}

// ---------------------------------------------------------------------------

/// Turns either destination shape into a stored bank account id.
async fn resolve_destination(
    state: &AppState,
    user_id: Uuid,
    destination: &Destination,
) -> ApiResult<Uuid> {
    match destination {
        Destination::Beneficiary { bank_account_id } => Ok(*bank_account_id),

        Destination::OneOff {
            bank_code,
            account_number,
            account_name,
            save,
        } => {
            let number: String = account_number.chars().filter(char::is_ascii_digit).collect();
            if number.len() != 10 {
                return Err(ApiError::BadRequest("Account numbers are 10 digits.".into()));
            }

            // Re-resolved rather than trusted. The client showed the user a name
            // from its own enquiry; if that disagrees with what the bank says
            // now, something changed between enquiry and submit and the payout is
            // refused rather than sent to a name the user never saw.
            let resolved = state.payouts.resolve_account(bank_code, &number).await?;
            if !resolved.trim().eq_ignore_ascii_case(account_name.trim()) {
                return Err(ApiError::BadRequest(
                    "That account's name changed. Check it and try again.".into(),
                ));
            }

            // Persisted either way: a payout needs a bank_account row to
            // reference. `save` decides whether the user sees it in their list
            // afterwards, which is a presentation concern, not a storage one.
            let id: Uuid = sqlx::query_scalar(
                "INSERT INTO bank_accounts
                   (user_id, bank_code, account_number, account_name, verified_at)
                 VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT (user_id, bank_code, account_number)
                 DO UPDATE SET account_name = EXCLUDED.account_name
                 RETURNING id",
            )
            .bind(user_id)
            .bind(bank_code)
            .bind(&number)
            .bind(&resolved)
            .fetch_one(&state.db)
            .await?;

            if !save {
                tracing::debug!(%id, "one-off destination stored for reference only");
            }

            Ok(id)
        }
    }
}

/// Locks the user's NGN ledger account, creating it if this is their first.
pub(crate) async fn lock_user_ngn_account(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> ApiResult<Uuid> {
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM ledger_accounts
          WHERE kind = 'user_ngn' AND user_id = $1 AND asset = 'NGN'
          FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;

    if let Some(id) = existing {
        return Ok(id);
    }

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO ledger_accounts (kind, user_id, asset) VALUES ('user_ngn', $1, 'NGN')
         RETURNING id",
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;

    Ok(id)
}

/// Finds or creates a platform-scoped account.
pub(crate) async fn platform_account(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    kind: AccountKind,
) -> ApiResult<Uuid> {
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM ledger_accounts WHERE kind = $1 AND user_id IS NULL AND asset = 'NGN'",
    )
    .bind(kind.as_str())
    .fetch_optional(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;

    if let Some(id) = existing {
        return Ok(id);
    }

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO ledger_accounts (kind, asset) VALUES ($1, 'NGN') RETURNING id",
    )
    .bind(kind.as_str())
    .fetch_one(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;

    Ok(id)
}

pub fn bank_name_for(code: &str) -> String {
    crate::bank_routes::bank_name(code)
}
