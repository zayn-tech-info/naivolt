//! A read-only window on what the platform is doing.
//!
//! ## This is not the admin panel ARCHITECTURE.md §10.4 describes
//!
//! That one has its own identity table, mandatory TOTP, an IP allowlist,
//! 30-minute sessions, RBAC across four roles, and every mutating action in the
//! hash-chained `audit_log`. It is days of work and it is the right answer for a
//! panel that can *move money*.
//!
//! This one moves nothing. Every endpoint here is a `SELECT`. It exists because
//! the alternative — running SQL over SSH to answer "did that top-up land" — is
//! worse in every way including safety, and because an operator who cannot see
//! the system cannot notice it is wrong.
//!
//! Access is a single shared token in `ADMIN_TOKEN`. That is a real limitation
//! and not a design: there is no per-person identity, so nothing here can be
//! attributed to who looked, and a leaked token exposes customer emails and
//! order history until it is rotated. Unset the variable and these routes stop
//! existing — which is the correct state for any deployment that does not need
//! them today.

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/overview", get(overview))
        .route("/admin/activity", get(activity))
}

/// Constant-time-ish check on the shared token.
///
/// `ADMIN_TOKEN` unset means the routes are off, and off answers 404 rather than
/// 401: a 401 tells a scanner the endpoint is real and worth guessing at.
fn authorise(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    let Some(expected) = state.admin_token.as_deref() else {
        return Err(ApiError::NotFound);
    };

    let presented = headers
        .get("x-admin-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    // Length first, then a byte-wise fold that does not stop early. Not a
    // hardened comparison, but it does not leak the token's prefix either.
    let matches = presented.len() == expected.len()
        && presented
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;

    if matches {
        Ok(())
    } else {
        Err(ApiError::NotFound)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub users: i64,
    pub orders_total: i64,
    pub orders_delivered: i64,
    pub orders_refunded: i64,
    pub orders_open: i64,
    pub orders_review_required: i64,
    pub topups_succeeded: i64,
    pub topups_pending: i64,
    /// What users could spend right now. A liability, so it is reported as a
    /// positive number owed rather than the negative the ledger stores.
    pub user_balances_ngn: String,
    /// Naira taken and not yet spent — the float behind those balances.
    pub float_ngn: String,
    /// Recognised on delivery, never on purchase.
    pub revenue_ngn: String,
    /// Reserved against orders still in flight.
    pub pending_ngn: String,
    /// What the supplier charged us, in the supplier's unit. Not a ledger
    /// figure: no leg books cost of goods yet (NUMBERS.md §7).
    pub supplier_cost: String,
    pub catalogue_products: i64,
    pub catalogue_in_stock: i64,
}

async fn overview(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Overview>> {
    authorise(&state, &headers)?;

    let row: (i64, i64, i64, i64, i64, i64, i64, i64, Decimal, Decimal, Decimal, Decimal, Decimal, i64, i64) =
        sqlx::query_as(
            "SELECT
               (SELECT count(*) FROM users),
               (SELECT count(*) FROM number_orders),
               (SELECT count(*) FROM number_orders WHERE status = 'delivered'),
               (SELECT count(*) FROM number_orders WHERE status IN ('expired','cancelled','failed')),
               (SELECT count(*) FROM number_orders WHERE status IN ('reserved','awaiting_code')),
               (SELECT count(*) FROM number_orders WHERE status = 'review_required'),
               (SELECT count(*) FROM ngn_deposits WHERE status = 'succeeded'),
               (SELECT count(*) FROM ngn_deposits WHERE status = 'pending'),
               COALESCE((SELECT -sum(e.amount) FROM ledger_entries e
                          JOIN ledger_accounts a ON a.id = e.account_id
                         WHERE a.kind = 'user_ngn'), 0),
               COALESCE((SELECT sum(e.amount) FROM ledger_entries e
                          JOIN ledger_accounts a ON a.id = e.account_id
                         WHERE a.kind = 'ngn_float'), 0),
               COALESCE((SELECT -sum(e.amount) FROM ledger_entries e
                          JOIN ledger_accounts a ON a.id = e.account_id
                         WHERE a.kind = 'number_revenue'), 0),
               COALESCE((SELECT sum(e.amount) FROM ledger_entries e
                          JOIN ledger_accounts a ON a.id = e.account_id
                         WHERE a.kind = 'number_payable_pending'), 0),
               COALESCE((SELECT sum(pr.provider_cost) FROM number_orders o
                          JOIN number_prices pr ON pr.product_id = o.product_id
                                               AND pr.country_id = o.country_id
                         WHERE o.status = 'delivered'), 0),
               (SELECT count(*) FROM number_products WHERE active),
               (SELECT count(*) FROM number_prices WHERE active AND stock > 0)",
        )
        .fetch_one(&state.db)
        .await?;

    Ok(Json(Overview {
        users: row.0,
        orders_total: row.1,
        orders_delivered: row.2,
        orders_refunded: row.3,
        orders_open: row.4,
        orders_review_required: row.5,
        topups_succeeded: row.6,
        topups_pending: row.7,
        user_balances_ngn: row.8.normalize().to_string(),
        float_ngn: row.9.normalize().to_string(),
        revenue_ngn: row.10.normalize().to_string(),
        pending_ngn: row.11.normalize().to_string(),
        supplier_cost: row.12.normalize().to_string(),
        catalogue_products: row.13,
        catalogue_in_stock: row.14,
    }))
}

#[derive(Deserialize)]
pub struct ActivityQuery {
    pub limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    /// `order` or `topup` — one feed, because "what happened" is one question.
    pub kind: String,
    pub id: String,
    pub who: Option<String>,
    pub what: String,
    pub amount_ngn: String,
    pub status: String,
    pub at: String,
}

async fn activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ActivityQuery>,
) -> ApiResult<Json<Vec<ActivityRow>>> {
    authorise(&state, &headers)?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);

    // Orders and top-ups interleaved by time. Two tables, one feed: an operator
    // asking what happened does not care which table it happened in.
    let rows: Vec<(
        String,
        String,
        Option<String>,
        String,
        Decimal,
        String,
        DateTime<Utc>,
    )> = sqlx::query_as(
        "SELECT 'order', o.id::text, u.email,
                    p.name || ' · ' || c.name, o.price_ngn, o.status, o.created_at
               FROM number_orders o
               JOIN users u ON u.id = o.user_id
               JOIN number_products p ON p.id = o.product_id
               JOIN number_countries c ON c.id = o.country_id
             UNION ALL
             SELECT 'topup', d.id::text, u.email,
                    d.provider, d.amount_ngn, d.status, d.created_at
               FROM ngn_deposits d
               JOIN users u ON u.id = d.user_id
             ORDER BY 7 DESC
             LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(kind, id, who, what, amount, status, at)| ActivityRow {
                kind,
                id,
                who,
                what,
                amount_ngn: amount.normalize().to_string(),
                status,
                at: at.to_rfc3339(),
            })
            .collect(),
    ))
}
