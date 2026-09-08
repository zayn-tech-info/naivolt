//! Operator overview, search, TOTP sessions, supplier recheck, and held refunds.
//!
//! Reads and enroll still use the shared `ADMIN_TOKEN`. Recheck and refund need
//! a named operator session. Money still goes through the existing order
//! transition. This is not the four role panel in ARCHITECTURE.md §10.4 (no IP
//! allowlist, no extra roles). Unset `ADMIN_TOKEN` and the read routes answer
//! 404.

use crate::error::{ApiError, ApiResult};
use crate::number_order_transitions::{self, OrderTransition, RefundStatus};
use crate::number_reconciler;
use crate::operator;
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/overview", get(overview))
        .route("/admin/activity", get(activity))
        .route("/admin/orders", get(list_orders))
        .route("/admin/orders/:id", get(order_detail))
        .route("/admin/orders/:id/recheck", post(recheck_order))
        .route("/admin/orders/:id/refund", post(refund_order))
        .route("/admin/operators", post(enroll_operator))
        .route("/admin/operator/session", post(create_session).delete(delete_session))
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
    pub oldest_open_age_seconds: Option<i64>,
    pub catalogue_synced_at: Option<String>,
    pub operator_refunds_last24h: i64,
    pub last_provider_error_category: Option<String>,
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

    let oldest_open_age_seconds: Option<i64> = sqlx::query_scalar(
        "SELECT EXTRACT(EPOCH FROM now() - min(created_at))::bigint
           FROM number_orders
          WHERE status IN ('reserved','awaiting_code','review_required')",
    )
    .fetch_one(&state.db)
    .await?;
    let catalogue_synced_at: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT max(synced_at) FROM number_prices")
            .fetch_one(&state.db)
            .await?;
    let operator_refunds_last24h: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log
          WHERE action = 'number_refund' AND created_at > now() - interval '24 hours'",
    )
    .fetch_one(&state.db)
    .await?;
    let last_provider_error_category: Option<String> = sqlx::query_scalar(
        "SELECT reconcile_last_error_category FROM number_orders
          WHERE status IN ('reserved','awaiting_code','review_required')
            AND reconcile_last_error_category IS NOT NULL
          ORDER BY reconcile_last_checked_at DESC NULLS LAST, created_at DESC
          LIMIT 1",
    )
    .fetch_optional(&state.db)
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
        oldest_open_age_seconds,
        catalogue_synced_at: catalogue_synced_at.map(|at| at.to_rfc3339()),
        operator_refunds_last24h,
        last_provider_error_category,
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

include!("admin_recovery.rs");
include!("admin_routes_tests.rs");
