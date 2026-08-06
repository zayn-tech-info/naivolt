//! Bank accounts, the institution list, and name enquiry.
//!
//! Name enquiry is the load-bearing piece here. It is the only thing standing
//! between a mistyped digit and an irreversible transfer to a stranger, so an
//! account cannot be saved without one succeeding — there is no "save anyway"
//! path, and the name we store is the one the bank returned, never one the
//! client supplied.
//!
//! ## Paystack, and what happens without it
//!
//! Resolution goes through Paystack's `/bank/resolve`. With no key configured —
//! which is every local machine — we fall back to a deterministic stub so the
//! withdraw flow is exercisable end to end. The stub is refused outright in
//! production by `Config::validate_for_environment`, because an app that
//! *appears* to verify account names while inventing them is worse than one
//! that cannot verify at all.

use crate::error::{ApiError, ApiResult};
use crate::middleware::CurrentUser;
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/banks", get(banks))
        .route("/banks/resolve", get(resolve))
        .route("/bank-accounts", get(list_accounts).post(add_account))
        .route("/bank-accounts/:id", delete(remove_account))
}

// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bank {
    pub code: String,
    pub name: String,
    /// `bank | fintech | microfinance`. The client groups fintechs first when
    /// the list is unfiltered — a large share of Nigerian transfers go to OPay,
    /// PalmPay, Kuda or Moniepoint, and burying those under an alphabetical run
    /// of commercial banks puts the most-used destinations at the bottom.
    pub kind: &'static str,
}

/// The institution list.
///
/// Static rather than fetched: Paystack's list changes a few times a year, it is
/// the same for every user, and a bank picker that fails because an upstream
/// call timed out is a withdraw flow that cannot start. When a Paystack key is
/// configured this should be refreshed from `/bank` on a schedule and cached —
/// tracked as a follow-up, not a blocker.
fn bank_list() -> Vec<Bank> {
    const ROWS: &[(&str, &str, &str)] = &[
        ("044", "Access Bank", "bank"),
        ("063", "Access Bank (Diamond)", "bank"),
        ("035A", "ALAT by Wema", "fintech"),
        ("023", "Citibank Nigeria", "bank"),
        ("050", "Ecobank Nigeria", "bank"),
        ("070", "Fidelity Bank", "bank"),
        ("011", "First Bank of Nigeria", "bank"),
        ("214", "FCMB", "bank"),
        ("058", "GTBank", "bank"),
        ("030", "Heritage Bank", "bank"),
        ("301", "Jaiz Bank", "bank"),
        ("082", "Keystone Bank", "bank"),
        ("090267", "Kuda Microfinance Bank", "fintech"),
        ("50515", "Moniepoint MFB", "fintech"),
        ("999992", "OPay", "fintech"),
        ("999991", "PalmPay", "fintech"),
        ("526", "Parallex Bank", "bank"),
        ("076", "Polaris Bank", "bank"),
        ("101", "Providus Bank", "bank"),
        ("221", "Stanbic IBTC Bank", "bank"),
        ("068", "Standard Chartered", "bank"),
        ("232", "Sterling Bank", "bank"),
        ("100", "SunTrust Bank", "bank"),
        ("032", "Union Bank of Nigeria", "bank"),
        ("033", "UBA", "bank"),
        ("215", "Unity Bank", "bank"),
        ("566", "VFD Microfinance Bank", "microfinance"),
        ("035", "Wema Bank", "bank"),
        ("057", "Zenith Bank", "bank"),
    ];

    ROWS.iter()
        .map(|(code, name, kind)| Bank {
            code: (*code).to_owned(),
            name: (*name).to_owned(),
            kind,
        })
        .collect()
}

/// Display name for a bank code, falling back to the code itself.
///
/// Shared with the payout path so a receipt and the account list can never
/// disagree about what a bank is called.
pub fn bank_name(code: &str) -> String {
    bank_list()
        .into_iter()
        .find(|b| b.code == code)
        .map(|b| b.name)
        .unwrap_or_else(|| code.to_owned())
}

async fn banks() -> ApiResult<Json<Vec<Bank>>> {
    Ok(Json(bank_list()))
}

// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ResolveQuery {
    pub bank_code: String,
    pub account_number: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAccount {
    pub account_name: String,
    pub bank_code: String,
    pub account_number: String,
}

async fn resolve(
    State(state): State<AppState>,
    _user: CurrentUser,
    Query(query): Query<ResolveQuery>,
) -> ApiResult<Json<ResolvedAccount>> {
    let number = normalise_account_number(&query.account_number)?;
    ensure_known_bank(&query.bank_code)?;

    let account_name = state
        .payouts
        .resolve_account(&query.bank_code, &number)
        .await?;

    Ok(Json(ResolvedAccount {
        account_name,
        bank_code: query.bank_code,
        account_number: number,
    }))
}

/// NUBAN account numbers are exactly ten digits.
///
/// Stripping non-digits first is deliberate: people paste them with spaces and
/// dashes, and rejecting a number that is correct but prettily formatted is a
/// dead end the user cannot diagnose.
fn normalise_account_number(raw: &str) -> ApiResult<String> {
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    if digits.len() != 10 {
        return Err(ApiError::BadRequest(
            "Account numbers are 10 digits.".into(),
        ));
    }
    Ok(digits)
}

fn ensure_known_bank(code: &str) -> ApiResult<()> {
    if bank_list().iter().any(|b| b.code == code) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!("unknown bank code {code}")))
    }
}

// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankAccountResponse {
    pub id: Uuid,
    pub bank_code: String,
    pub bank_name: String,
    pub account_number: String,
    pub account_name: String,
    pub verified_at: Option<String>,
    /// Drives the client's ordering, which puts the most recently paid account
    /// first — paying the same account again is the overwhelmingly common case.
    pub last_used_at: Option<String>,
}

async fn list_accounts(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<BankAccountResponse>>> {
    // Ordered by last payout, nulls last. Done in SQL rather than the client so
    // every consumer gets the same order.
    let rows: Vec<(
        Uuid,
        String,
        String,
        String,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<chrono::DateTime<chrono::Utc>>,
    )> = sqlx::query_as(
        "SELECT ba.id, ba.bank_code, ba.account_number, ba.account_name, ba.verified_at,
                (SELECT MAX(p.created_at) FROM payouts p WHERE p.bank_account_id = ba.id)
           FROM bank_accounts ba
          WHERE ba.user_id = $1
          ORDER BY (SELECT MAX(p.created_at) FROM payouts p WHERE p.bank_account_id = ba.id)
                   DESC NULLS LAST,
                   ba.created_at DESC",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    let banks = bank_list();
    Ok(Json(
        rows.into_iter()
            .map(|(id, bank_code, account_number, account_name, verified_at, last_used_at)| {
                let bank_name = banks
                    .iter()
                    .find(|b| b.code == bank_code)
                    .map(|b| b.name.clone())
                    .unwrap_or_else(|| bank_code.clone());
                BankAccountResponse {
                    id,
                    bank_code,
                    bank_name,
                    account_number,
                    account_name,
                    verified_at: verified_at.map(|t| t.to_rfc3339()),
                    last_used_at: last_used_at.map(|t| t.to_rfc3339()),
                }
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddAccountBody {
    pub bank_code: String,
    pub account_number: String,
    /// Accepted but not trusted — see below.
    pub account_name: Option<String>,
}

async fn add_account(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<AddAccountBody>,
) -> ApiResult<Json<BankAccountResponse>> {
    let number = normalise_account_number(&body.account_number)?;
    ensure_known_bank(&body.bank_code)?;

    // Re-resolved server-side rather than trusting the name the client sent.
    // The client displays a name from its own earlier enquiry; accepting that
    // back would let a tampered client store any name it liked against someone
    // else's account number, which is exactly the confusion a payout screen
    // must not have.
    let account_name = state
        .payouts
        .resolve_account(&body.bank_code, &number)
        .await?;

    if let Some(claimed) = body.account_name.as_deref() {
        if !claimed.trim().is_empty() && !claimed.trim().eq_ignore_ascii_case(account_name.trim()) {
            tracing::warn!(
                user_id = %user.id,
                "client-supplied account name disagreed with enquiry; using the bank's"
            );
        }
    }

    // Idempotent on (user, bank, number): tapping save twice returns the
    // existing row instead of failing on the unique constraint.
    let (id, verified_at): (Uuid, Option<chrono::DateTime<chrono::Utc>>) = sqlx::query_as(
        "INSERT INTO bank_accounts (user_id, bank_code, account_number, account_name, verified_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, bank_code, account_number)
         DO UPDATE SET account_name = EXCLUDED.account_name, verified_at = now()
         RETURNING id, verified_at",
    )
    .bind(user.id)
    .bind(&body.bank_code)
    .bind(&number)
    .bind(&account_name)
    .fetch_one(&state.db)
    .await?;

    let bank_name = bank_list()
        .into_iter()
        .find(|b| b.code == body.bank_code)
        .map(|b| b.name)
        .unwrap_or_else(|| body.bank_code.clone());

    Ok(Json(BankAccountResponse {
        id,
        bank_code: body.bank_code,
        bank_name,
        account_number: number,
        account_name,
        verified_at: verified_at.map(|t| t.to_rfc3339()),
        last_used_at: None,
    }))
}

async fn remove_account(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    // Scoped to the caller: without the user_id predicate this would delete any
    // account by id, for anyone.
    let result = sqlx::query("DELETE FROM bank_accounts WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_numbers_accept_human_formatting() {
        assert_eq!(normalise_account_number("0123454821").unwrap(), "0123454821");
        assert_eq!(normalise_account_number("012 345 4821").unwrap(), "0123454821");
        assert_eq!(normalise_account_number("0123-4548-21").unwrap(), "0123454821");
    }

    #[test]
    fn account_numbers_must_be_ten_digits() {
        assert!(normalise_account_number("12345").is_err());
        assert!(normalise_account_number("01234548210").is_err());
        assert!(normalise_account_number("").is_err());
    }

    #[test]
    fn unknown_bank_codes_are_rejected() {
        // A code we do not know cannot be resolved or paid to, so accepting it
        // would store an account that silently fails at payout time.
        assert!(ensure_known_bank("058").is_ok());
        assert!(ensure_known_bank("999999").is_err());
    }

    #[test]
    fn the_fintechs_nigerians_actually_use_are_present() {
        let codes: Vec<String> = bank_list().into_iter().map(|b| b.code).collect();
        for expected in ["999992", "999991", "090267", "50515"] {
            assert!(codes.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn bank_codes_are_unique() {
        let mut codes: Vec<String> = bank_list().into_iter().map(|b| b.code).collect();
        let before = codes.len();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), before, "duplicate bank code in the list");
    }
}
