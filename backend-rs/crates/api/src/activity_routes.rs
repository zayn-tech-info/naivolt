//! Activity — the unified feed, and the receipt behind each row.
//!
//! One list, every kind. The client deliberately has no separate deposit and
//! payout histories, because "where is my money" is one question and answering
//! it across two screens is not answering it.
//!
//! ## Signs are from the user's side, not the ledger's
//!
//! Amounts here are unsigned and direction comes from `kind`. The ledger stores
//! liabilities negative (ARCHITECTURE.md §5) — correct accounting, and exactly
//! backwards for a person reading their own history, where a deposit is money
//! coming *in*.
//!
//! ## The timeline is the point
//!
//! "Pending" does not answer "where is my money". Each kind carries its real
//! sequence — a deposit confirms on chain, a payout settles at a bank — so the
//! receipt can show which step it is sitting on rather than a spinner.

use crate::error::{ApiError, ApiResult};
use crate::middleware::CurrentUser;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/activity", get(list_activity))
        .route("/activity/:id", get(activity_detail))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    pub id: Uuid,
    /// `deposit | payout`. Gift cards join this list when that table lands.
    pub kind: &'static str,
    pub asset: String,
    /// Unsigned. Direction is carried by `kind`.
    pub amount: String,
    pub ngn_value: Option<String>,
    pub status: String,
    pub created_at: String,
    /// Short, already-formatted subtitle. Built here because it varies by kind
    /// and the client should not hold a formatting switch per kind.
    pub detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityList {
    pub items: Vec<ActivityItem>,
    pub next_cursor: Option<String>,
}

/// Newest first. The client groups into Today / Yesterday / date headers and
/// relies on this ordering.
async fn list_activity(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<ActivityList>> {
    let mut items = Vec::new();

    let deposits: Vec<(Uuid, String, String, Decimal, i32, String, DateTime<Utc>)> =
        sqlx::query_as(
            "SELECT id, asset, network, amount, confirmations, status, created_at
               FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
        )
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;

    for (id, asset, network, amount, confirmations, status, created_at) in deposits {
        items.push(ActivityItem {
            id,
            kind: "deposit",
            asset: asset.clone(),
            amount: amount.normalize().to_string(),
            // Valued at today's rate, not the rate when it landed. Honest for a
            // holding the user still has; a historical rate would need to be
            // captured at credit time, which the watcher does not do yet.
            ngn_value: state
                .rates
                .ngn_rate_of(&asset)
                .await
                .map(|rate| (amount * rate).round_dp(4).normalize().to_string()),
            status,
            created_at: created_at.to_rfc3339(),
            detail: Some(format!("{network} · {confirmations} confirmations")),
        });
    }

    let payouts: Vec<(Uuid, Decimal, String, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT p.id, p.amount_ngn, p.status, ba.bank_code, ba.account_number, p.created_at
           FROM payouts p
           JOIN bank_accounts ba ON ba.id = p.bank_account_id
          WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 100",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    for (id, amount, status, bank_code, account_number, created_at) in payouts {
        items.push(ActivityItem {
            id,
            kind: "payout",
            asset: "NGN".into(),
            amount: amount.normalize().to_string(),
            ngn_value: Some(amount.normalize().to_string()),
            status,
            created_at: created_at.to_rfc3339(),
            detail: Some(format!(
                "{} ···{}",
                crate::bank_routes::bank_name(&bank_code),
                last4(&account_number)
            )),
        });
    }

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(Json(ActivityList {
        items,
        // Everything fits in the per-kind limits above for now. Real pagination
        // waits for a unified view rather than being faked with an offset that
        // two independent queries cannot honour consistently.
        next_cursor: None,
    }))
}

// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineStep {
    pub label: String,
    pub at: Option<String>,
    /// `done | current | pending | failed`
    pub state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDetail {
    #[serde(flatten)]
    pub item: ActivityItem,
    pub reference: Option<String>,
    pub timeline: Vec<TimelineStep>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explorer_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmations: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_confirmations: Option<i32>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub bank_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

async fn activity_detail(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<ActivityDetail>> {
    // Both lookups are scoped to the caller. Without that, any id would return
    // any user's receipt.
    if let Some(detail) = deposit_detail(&state, user.id, id).await? {
        return Ok(Json(detail));
    }
    if let Some(detail) = payout_detail(&state, user.id, id).await? {
        return Ok(Json(detail));
    }
    Err(ApiError::NotFound)
}

async fn deposit_detail(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
) -> ApiResult<Option<ActivityDetail>> {
    let row: Option<(String, String, String, Decimal, i32, String, String, DateTime<Utc>)> =
        sqlx::query_as(
            "SELECT asset, network, chain, amount, confirmations, status, tx_hash, created_at
               FROM deposits WHERE id = $1 AND user_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;

    let Some((asset, network, chain, amount, confirmations, status, tx_hash, created_at)) = row
    else {
        return Ok(None);
    };

    let min_confirmations = min_confirmations_for(&network);
    let credited = status == "credited";
    let reversed = status == "reversed";

    let timeline = vec![
        TimelineStep {
            label: "Seen on-chain".into(),
            at: Some(created_at.to_rfc3339()),
            state: "done",
        },
        TimelineStep {
            label: format!("Confirming ({confirmations}/{min_confirmations})"),
            at: Some(created_at.to_rfc3339()),
            state: if reversed {
                "failed"
            } else if credited {
                "done"
            } else {
                "current"
            },
        },
        TimelineStep {
            label: "Credited to your balance".into(),
            at: credited.then(|| created_at.to_rfc3339()),
            state: if credited { "done" } else { "pending" },
        },
    ];

    Ok(Some(ActivityDetail {
        item: ActivityItem {
            id,
            kind: "deposit",
            asset: asset.clone(),
            amount: amount.normalize().to_string(),
            ngn_value: state
                .rates
                .ngn_rate_of(&asset)
                .await
                .map(|rate| (amount * rate).round_dp(4).normalize().to_string()),
            status,
            created_at: created_at.to_rfc3339(),
            detail: Some(format!("{network} · {confirmations} confirmations")),
        },
        reference: Some(short_reference(id)),
        timeline,
        explorer_url: explorer_url(&chain, &tx_hash),
        tx_hash: Some(tx_hash),
        network: Some(network),
        confirmations: Some(confirmations),
        min_confirmations: Some(min_confirmations),
        bank_name: None,
        account_number: None,
        account_name: None,
        fee: None,
        failure_reason: reversed
            .then(|| "This deposit was reversed after a chain reorganisation.".to_owned()),
    }))
}

async fn payout_detail(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
) -> ApiResult<Option<ActivityDetail>> {
    let row: Option<(
        Decimal,
        Decimal,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        DateTime<Utc>,
        DateTime<Utc>,
    )> = sqlx::query_as(
        "SELECT p.amount_ngn, p.fee_ngn, p.status, p.provider_reference, p.failure_reason,
                ba.bank_code, ba.account_number, ba.account_name, p.created_at, p.updated_at
           FROM payouts p
           JOIN bank_accounts ba ON ba.id = p.bank_account_id
          WHERE p.id = $1 AND p.user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let Some((
        amount,
        fee,
        status,
        reference,
        failure_reason,
        bank_code,
        account_number,
        account_name,
        created_at,
        updated_at,
    )) = row
    else {
        return Ok(None);
    };

    let settled = status == "settled";
    let failed = matches!(status.as_str(), "failed" | "reversed");
    // `reserved` means funds are held but the provider has not been called yet.
    // Reporting that as "sent to your bank" would tell someone their money is on
    // its way when it has not left — the single most damaging thing this screen
    // could get wrong.
    let sent = matches!(status.as_str(), "processing" | "settled");

    let timeline = vec![
        TimelineStep {
            label: "Requested".into(),
            at: Some(created_at.to_rfc3339()),
            state: "done",
        },
        TimelineStep {
            label: if failed {
                "Failed at the bank".into()
            } else {
                "Sent to your bank".into()
            },
            at: (sent || failed).then(|| updated_at.to_rfc3339()),
            state: if failed {
                "failed"
            } else if sent {
                "done"
            } else {
                "current"
            },
        },
        TimelineStep {
            label: "Settled".into(),
            at: settled.then(|| updated_at.to_rfc3339()),
            state: if settled {
                "done"
            } else if sent {
                "current"
            } else {
                // Not reachable yet, and not a failure either.
                "pending"
            },
        },
    ];

    Ok(Some(ActivityDetail {
        item: ActivityItem {
            id,
            kind: "payout",
            asset: "NGN".into(),
            amount: amount.normalize().to_string(),
            ngn_value: Some(amount.normalize().to_string()),
            status,
            created_at: created_at.to_rfc3339(),
            detail: Some(format!(
                "{} ···{}",
                crate::bank_routes::bank_name(&bank_code),
                last4(&account_number)
            )),
        },
        reference: Some(reference),
        timeline,
        tx_hash: None,
        explorer_url: None,
        network: None,
        confirmations: None,
        min_confirmations: None,
        bank_name: Some(crate::bank_routes::bank_name(&bank_code)),
        // Full number, not masked: this is the last place a user checks where
        // their money went, and a masked number cannot be verified against a
        // bank statement.
        account_number: Some(account_number),
        account_name: Some(account_name),
        fee: Some(fee.normalize().to_string()),
        failure_reason,
    }))
}

// ---------------------------------------------------------------------------

fn last4(account_number: &str) -> &str {
    let len = account_number.len();
    &account_number[len.saturating_sub(4)..]
}

fn short_reference(id: Uuid) -> String {
    format!("NV-{}", &id.simple().to_string()[..8].to_uppercase())
}

fn min_confirmations_for(network: &str) -> i32 {
    match network.to_ascii_lowercase().as_str() {
        "ethereum" => 12,
        "bsc" | "polygon" | "tron" => 20,
        "base" => 10,
        "bitcoin" => 2,
        "solana" => 1,
        _ => 12,
    }
}

/// A link the user can open to see the transaction themselves.
///
/// Being able to verify a deposit against a public explorer is most of what
/// makes a custodial service trustworthy, so an unknown chain returns None
/// rather than a guessed URL that 404s.
fn explorer_url(chain: &str, tx_hash: &str) -> Option<String> {
    let base = match chain.to_ascii_lowercase().as_str() {
        "tron" => "https://tronscan.org/#/transaction/",
        "evm" | "ethereum" => "https://etherscan.io/tx/",
        "bsc" => "https://bscscan.com/tx/",
        "polygon" => "https://polygonscan.com/tx/",
        "base" => "https://basescan.org/tx/",
        "bitcoin" => "https://mempool.space/tx/",
        "solana" => "https://solscan.io/tx/",
        _ => return None,
    };
    Some(format!("{base}{tx_hash}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last4_handles_short_numbers_without_panicking() {
        assert_eq!(last4("0123454821"), "4821");
        assert_eq!(last4("821"), "821");
        assert_eq!(last4(""), "");
    }

    #[test]
    fn unknown_chains_get_no_explorer_link_rather_than_a_broken_one() {
        assert!(explorer_url("dogechain", "0xabc").is_none());
        assert!(explorer_url("tron", "abc").unwrap().contains("tronscan"));
    }

    #[test]
    fn confirmation_thresholds_match_the_deposit_screen() {
        // These are what the app told the user to expect when it showed the
        // address; a receipt disagreeing with that is a support ticket.
        assert_eq!(min_confirmations_for("ethereum"), 12);
        assert_eq!(min_confirmations_for("bsc"), 20);
        assert_eq!(min_confirmations_for("base"), 10);
        assert_eq!(min_confirmations_for("bitcoin"), 2);
    }
}
