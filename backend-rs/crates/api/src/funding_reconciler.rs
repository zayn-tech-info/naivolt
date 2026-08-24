//! Chasing top-ups nobody is watching.
//!
//! The dashboard confirms a charge when the payer comes back from Paystack. A
//! payer who closes the tab has still been charged, and without this their money
//! sits with the provider while their balance says nothing arrived — a support
//! ticket at best, and the kind that reads like theft.
//!
//! This is the same verify call the route makes, on a timer instead of on a page
//! load. Deliberately not a webhook: Paystack's verify endpoint is authoritative
//! and needs no signature handling, so there is no forged POST that can credit an
//! account (NUMBERS.md §2). A webhook belongs in front of this as a latency
//! optimisation, never as the thing that makes it correct.

use crate::funding_routes::settle;
use crate::state::AppState;
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use std::time::Duration;
use uuid::Uuid;

/// How often to sweep. Well under the window in which someone notices their
/// balance is wrong, and far too slow to matter as load on Paystack.
const INTERVAL: Duration = Duration::from_secs(30);

/// Leave an intent alone for this long first. The dashboard's own verify runs
/// within a second or two of the redirect, and there is no reason for both to
/// ask at once.
const SETTLE_AFTER_SECONDS: i64 = 20;

/// After this, a pending intent is abandoned rather than verified forever.
/// Paystack's checkout link is long dead by then; what remains is a row that
/// would otherwise be re-verified every 30 seconds for the life of the process.
const ABANDON_AFTER_HOURS: i64 = 24;

/// How many to settle per pass. A backlog drains over several sweeps rather than
/// opening hundreds of provider calls at once.
const BATCH: i64 = 50;

pub fn spawn(state: AppState) {
    // The stub confirms every charge it is asked about, so running this against
    // it would credit balances nobody paid for — including intents a user
    // deliberately abandoned.
    if !state.funding.is_live() {
        tracing::info!("funding reconciler not started — the funding provider is stubbed");
        return;
    }

    tokio::spawn(async move {
        loop {
            tokio::time::sleep(INTERVAL).await;
            if let Err(err) = sweep(&state).await {
                // A failed sweep is not fatal: the next one sees the same rows.
                tracing::warn!(error = ?err, "funding reconciler sweep failed");
            }
        }
    });

    tracing::info!(
        interval_s = INTERVAL.as_secs(),
        "funding reconciler started — pending top-ups are chased whether or not the payer returns"
    );
}

async fn sweep(state: &AppState) -> anyhow::Result<()> {
    let rows: Vec<(Uuid, Uuid, Decimal, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, user_id, amount_ngn, provider_reference, created_at
           FROM ngn_deposits
          WHERE status = 'pending'
            AND provider = 'paystack'
            AND created_at < now() - make_interval(secs => $1)
            AND created_at > now() - make_interval(hours => $2)
          ORDER BY created_at
          LIMIT $3",
    )
    .bind(SETTLE_AFTER_SECONDS as f64)
    .bind(ABANDON_AFTER_HOURS as f64)
    .bind(BATCH)
    .fetch_all(&state.db)
    .await?;

    for (id, user_id, amount, reference, created_at) in rows {
        match settle(state, id, user_id, &reference, amount).await {
            Ok(status) if status == "pending" => {}
            Ok(status) => tracing::info!(
                intent = %id, %reference, %status, age_s = (Utc::now() - created_at).num_seconds(),
                "settled a top-up its payer never came back for"
            ),
            Err(err) => {
                tracing::warn!(intent = %id, error = %err, "could not settle a pending top-up")
            }
        }
    }

    // Anything older than the window is closed out. `status = 'pending'` is what
    // the sweep selects on, so leaving these open would mean re-verifying dead
    // references forever.
    let abandoned = sqlx::query(
        "UPDATE ngn_deposits
            SET status = 'abandoned', updated_at = now()
          WHERE status = 'pending'
            AND provider = 'paystack'
            AND created_at < now() - make_interval(hours => $1)",
    )
    .bind(ABANDON_AFTER_HOURS as f64)
    .execute(&state.db)
    .await?
    .rows_affected();

    if abandoned > 0 {
        tracing::info!(count = abandoned, "abandoned top-ups that were never paid");
    }

    Ok(())
}
