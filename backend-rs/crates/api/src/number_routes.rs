//! Virtual numbers — buy a number, collect its code.
//!
//! The order of operations is the design, and it is the payout reservation
//! (ARCHITECTURE.md §8) applied to a different counterparty:
//!
//! ```text
//! reserve   user_ngn:{u}            +620     (liability shrinks)
//!           number_payable_pending  -620     (owed back if no code arrives)
//!
//! settle    number_payable_pending  +620     (discharged)
//!           number_revenue          -620     (recognised — the code landed)
//!
//! refund    number_payable_pending  +620     (discharged)
//!           user_ngn:{u}            -620     (owed to the user again)
//! ```
//!
//! Naira leaves the spendable balance *before* the supplier is called, under a
//! row lock, so two taps on Buy cannot spend it twice and a crash mid-purchase
//! cannot duplicate it. Revenue is not recognised at purchase: an order that
//! never receives a code was never a sale, and settling early would book revenue
//! we then have to claw back.
//!
//! If the supplier call fails, the reservation is reversed immediately — the
//! user is whole before the request returns.

use crate::error::{ApiError, ApiResult};
use crate::middleware::CurrentUser;
use crate::number_provider::{ActivationState, Sms};
use crate::payout_routes::{lock_user_ngn_account, platform_account};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use naivolt_core::Asset;
use naivolt_ledger::{AccountKind, JournalKind};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/numbers/catalog", get(catalog))
        .route("/numbers/products", get(products))
        .route("/numbers/products/:slug/countries", get(product_countries))
        .route("/numbers/orders", post(create_order).get(list_orders))
        .route("/numbers/orders/:id", get(get_order))
}

// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProduct {
    pub slug: String,
    pub name: String,
    pub countries: Vec<CatalogCountry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCountry {
    pub code: String,
    pub name: String,
    pub dial_code: String,
    pub price_ngn: String,
    pub in_stock: bool,
}

/// The curated shortlist, fully expanded.
///
/// Deliberately not the whole catalogue any more. The sync discovers ~1,000
/// products across 153 countries, and the cross product is ~75,000 rows — a
/// payload no phone should be asked to parse to render a picker. This stays
/// capped at the products someone chose to feature, and `/numbers/products`
/// plus `/numbers/products/{slug}/countries` serve the rest on demand.
async fn catalog(State(state): State<AppState>) -> ApiResult<Json<Vec<CatalogProduct>>> {
    let rows: Vec<(String, String, i32, String, String, String, Decimal, i32)> = sqlx::query_as(
        "SELECT p.slug, p.name, p.sort_order,
                c.code, c.name, c.dial_code,
                pr.price_ngn, pr.stock
           FROM number_prices pr
           JOIN number_products  p ON p.id = pr.product_id
           JOIN number_countries c ON c.id = pr.country_id
          WHERE pr.active AND p.active AND c.active
            AND p.sort_order < 500 AND c.sort_order < 500
          ORDER BY p.sort_order, p.name, c.sort_order, c.name",
    )
    .fetch_all(&state.db)
    .await?;

    let mut products: Vec<CatalogProduct> = Vec::new();
    for (slug, name, _sort, code, country_name, dial_code, price_ngn, stock) in rows {
        let country = CatalogCountry {
            code,
            name: country_name,
            dial_code,
            price_ngn: price_ngn.normalize().to_string(),
            // Stock is whatever the last sync saw. It is a hint for ordering the
            // list, not a promise — the supplier can sell out between the sync
            // and the purchase, which is why `buy` has its own out-of-stock path.
            in_stock: stock > 0,
        };

        match products.last_mut() {
            Some(last) if last.slug == slug => last.countries.push(country),
            _ => products.push(CatalogProduct {
                slug,
                name,
                countries: vec![country],
            }),
        }
    }

    Ok(Json(products))
}

// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ProductQuery {
    /// Free text against the product name. Absent means "the popular ones".
    pub q: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductSummary {
    pub slug: String,
    pub name: String,
    /// Cheapest country currently in stock, which is what a list wants to show.
    pub from_price_ngn: Option<String>,
    /// How many countries have it right now — the difference between "rare" and
    /// "everywhere", and the only honest way to order a list this long.
    pub country_count: i64,
}

/// Search the catalogue.
///
/// A thousand products cannot be a dropdown, and a phone cannot hold the cross
/// product. This returns a page of them, ordered by curation first and then by
/// how widely available they are.
async fn products(
    State(state): State<AppState>,
    Query(query): Query<ProductQuery>,
) -> ApiResult<Json<Vec<ProductSummary>>> {
    let limit = query.limit.unwrap_or(60).clamp(1, 200);
    let search = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| format!("%{}%", q.to_lowercase()));

    let rows: Vec<(String, String, Option<Decimal>, i64)> = sqlx::query_as(
        "SELECT p.slug, p.name, min(pr.price_ngn), count(*)
           FROM number_products p
           JOIN number_prices  pr ON pr.product_id = p.id AND pr.active AND pr.stock > 0
           JOIN number_countries c ON c.id = pr.country_id AND c.active
          WHERE p.active
            AND ($1::text IS NULL OR lower(p.name) LIKE $1 OR p.slug LIKE $1)
          GROUP BY p.id, p.slug, p.name, p.sort_order
          ORDER BY p.sort_order, count(*) DESC, p.name
          LIMIT $2",
    )
    .bind(search.as_deref())
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(slug, name, from, count)| ProductSummary {
                slug,
                name,
                from_price_ngn: from.map(|p| p.normalize().to_string()),
                country_count: count,
            })
            .collect(),
    ))
}

/// Where one product can be bought, cheapest first.
///
/// Only what is in stock: a country listed at a price you cannot buy at is worse
/// than a country not listed, because the failure arrives after the tap.
async fn product_countries(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> ApiResult<Json<Vec<CatalogCountry>>> {
    let rows: Vec<(String, String, String, Decimal, i32)> = sqlx::query_as(
        "SELECT c.code, c.name, c.dial_code, pr.price_ngn, pr.stock
           FROM number_prices pr
           JOIN number_products  p ON p.id = pr.product_id
           JOIN number_countries c ON c.id = pr.country_id
          WHERE p.slug = $1 AND pr.active AND p.active AND c.active AND pr.stock > 0
          ORDER BY pr.price_ngn, c.sort_order, c.name
          LIMIT 200",
    )
    .bind(slug.trim().to_lowercase())
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(code, name, dial_code, price_ngn, stock)| CatalogCountry {
                code,
                name,
                dial_code,
                price_ngn: price_ngn.normalize().to_string(),
                in_stock: stock > 0,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOrderBody {
    pub product_slug: String,
    pub country_code: String,
    /// What the client last showed the user. Optional, but when it is sent an
    /// order that would cost more than that is refused rather than charged: the
    /// catalogue tracks the supplier now, so a price can move between reading a
    /// page and buying from it.
    pub expected_price_ngn: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageResponse {
    pub sender: Option<String>,
    pub text: String,
    pub code: Option<String>,
    pub received_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderResponse {
    pub id: Uuid,
    pub reference: String,
    pub product: String,
    pub country: String,
    pub country_code: String,
    pub price_ngn: String,
    pub status: String,
    pub phone_number: Option<String>,
    pub code: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: String,
    /// Everything the number received. Empty on the list endpoint, which would
    /// otherwise fetch an inbox per row to render a summary nobody reads.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub messages: Vec<MessageResponse>,
}

async fn create_order(
    State(state): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
    Json(body): Json<CreateOrderBody>,
) -> ApiResult<Json<OrderResponse>> {
    // One key per intent, reused across retries. Without it there is a path that
    // spends a user's balance twice on a flaky connection.
    let idempotency_key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::BadRequest("Idempotency-Key header is required".into()))?;

    let (product_id, product_name, provider_product): (Uuid, String, String) = sqlx::query_as(
        "SELECT id, name, provider_product FROM number_products WHERE slug = $1 AND active",
    )
    .bind(body.product_slug.trim().to_lowercase())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::BadRequest("We don't sell numbers for that app.".into()))?;

    let (country_id, country_name, provider_country): (Uuid, String, String) = sqlx::query_as(
        "SELECT id, name, provider_country FROM number_countries WHERE code = $1 AND active",
    )
    .bind(body.country_code.trim().to_uppercase())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::BadRequest("We don't sell numbers in that country.".into()))?;

    let price_ngn: Decimal = sqlx::query_scalar(
        "SELECT price_ngn FROM number_prices
          WHERE product_id = $1 AND country_id = $2 AND active",
    )
    .bind(product_id)
    .bind(country_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        ApiError::BadRequest("That app isn't available in that country yet.".into())
    })?;

    // Real money must not buy a number that does not exist. The stub issues
    // plausible-looking activations that always deliver `123456`, which is
    // exactly what a developer wants and exactly what a paying customer must
    // never receive. Production refuses to boot without a supplier key at all;
    // this covers the staging box in between, where the balance being spent was
    // charged to a real card.
    if !state.numbers.is_live() && state.funding.is_live() {
        return Err(ApiError::ServiceUnavailable(
            "Numbers aren't on sale yet. Nothing has been charged.".into(),
        ));
    }

    if let Some(expected) = body.expected_price_ngn.as_deref() {
        let expected = Decimal::from_str(expected.trim())
            .map_err(|_| ApiError::BadRequest("That expected price isn't a number.".into()))?;
        // Only a rise is refused. A number that got cheaper is charged at the
        // cheaper price, which needs no permission from anyone.
        if price_ngn > expected {
            return Err(ApiError::PriceMoved {
                price_ngn: price_ngn.normalize().to_string(),
            });
        }
    }

    // --- Reserve, under a row lock -------------------------------------------
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;

    let ngn_account_id = lock_user_ngn_account(&mut tx, user.id).await?;

    let raw_balance: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE account_id = $1",
    )
    .bind(ngn_account_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    if price_ngn > AccountKind::UserNgn.user_facing_balance(raw_balance) {
        return Err(ApiError::InsufficientBalance);
    }

    let pending_account_id = platform_account(&mut tx, AccountKind::NumberPayablePending).await?;
    let reference = format!("NVNO-{}", &Uuid::new_v4().simple().to_string()[..10].to_uppercase());

    let journal = naivolt_ledger::journal::JournalBuilder::new(
        JournalKind::NumberReserve,
        reference.clone(),
        idempotency_key.clone(),
    )
    .entry(ngn_account_id, AccountKind::UserNgn, Asset::Ngn, price_ngn)
    .entry(
        pending_account_id,
        AccountKind::NumberPayablePending,
        Asset::Ngn,
        -price_ngn,
    )
    .metadata(serde_json::json!({
        "product": body.product_slug,
        "country": body.country_code,
    }))
    .build()
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    let outcome = journal
        .post(&mut tx)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    // A replay of the same intent returns the original order rather than buying
    // a second number. The journal is already idempotent; this keeps the order
    // row in step with it.
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM number_orders WHERE reserved_journal_id = $1")
            .bind(outcome.journal_id())
            .fetch_optional(&mut *tx)
            .await
            .map_err(anyhow::Error::from)?;

    if let Some(id) = existing {
        tx.commit().await.map_err(anyhow::Error::from)?;
        return load_order(&state, user.id, id).await.map(Json);
    }

    let (order_id, created_at): (Uuid, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO number_orders
           (user_id, product_id, country_id, price_ngn, provider, status, reference,
            reserved_journal_id)
         VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7)
         RETURNING id, created_at",
    )
    .bind(user.id)
    .bind(product_id)
    .bind(country_id)
    .bind(price_ngn)
    .bind(if state.numbers.is_live() { "5sim" } else { "stub" })
    .bind(&reference)
    .bind(outcome.journal_id())
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    tx.commit().await.map_err(anyhow::Error::from)?;

    // --- Only now is the supplier called -------------------------------------
    // The reservation is durable. If this fails the user is refunded before the
    // response returns, so a supplier outage costs them nothing.
    let activation = match state.numbers.buy(&provider_country, &provider_product).await {
        Ok(activation) => activation,
        Err(err) => {
            refund_order(&state, order_id, &reference, price_ngn, user.id, "supplier_unavailable")
                .await?;
            return Err(err);
        }
    };

    sqlx::query(
        "UPDATE number_orders
            SET status = 'awaiting_code', provider_order_id = $2, phone_number = $3,
                provider_cost = $4, provider_cost_currency = $5, expires_at = $6,
                updated_at = now()
          WHERE id = $1",
    )
    .bind(order_id)
    .bind(&activation.provider_order_id)
    .bind(&activation.phone)
    .bind(activation.cost)
    .bind(activation.cost_currency.as_deref())
    .bind(activation.expires_at)
    .execute(&state.db)
    .await?;

    Ok(Json(OrderResponse {
        id: order_id,
        reference,
        product: product_name,
        country: country_name,
        country_code: body.country_code.trim().to_uppercase(),
        price_ngn: price_ngn.normalize().to_string(),
        status: "awaiting_code".into(),
        phone_number: Some(activation.phone),
        code: None,
        expires_at: activation.expires_at.map(|t| t.to_rfc3339()),
        created_at: created_at.to_rfc3339(),
        messages: Vec::new(),
    }))
}

// ---------------------------------------------------------------------------

async fn list_orders(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<OrderResponse>>> {
    let rows: Vec<OrderRow> = sqlx::query_as(&format!(
        "SELECT {ORDER_COLUMNS} {ORDER_FROM}
          WHERE o.user_id = $1
          ORDER BY o.created_at DESC
          LIMIT 50"
    ))
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows.into_iter().map(into_response).collect()))
}

/// Reads an order, and advances it first if the supplier has news.
///
/// The client polls this. There is no separate worker yet: the only orders that
/// need chasing are ones a user is actively watching, and asking the supplier on
/// their behalf is both simpler and exactly as timely.
async fn get_order(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<OrderResponse>> {
    let row: Option<(String, Option<String>, Decimal, String, Option<DateTime<Utc>>)> =
        sqlx::query_as(
            "SELECT status, provider_order_id, price_ngn, reference, expires_at
               FROM number_orders WHERE id = $1 AND user_id = $2",
        )
        .bind(id)
        .bind(user.id)
        .fetch_optional(&state.db)
        .await?;

    let (status, provider_order_id, price_ngn, reference, expires_at) =
        row.ok_or(ApiError::NotFound)?;

    let is_open = matches!(status.as_str(), "reserved" | "awaiting_code");

    if let (true, Some(provider_order_id)) = (is_open, provider_order_id.as_deref()) {
        match state.numbers.check(provider_order_id).await {
            Ok(ActivationState::Received {
                code,
                text,
                messages,
            }) => {
                // Messages first: the order settles once, but a number that
                // takes a second message after settling still has it recorded.
                save_messages(&state, id, &messages).await;
                if is_open {
                    settle_order(&state, id, &reference, price_ngn, &code, &text).await?;
                }
            }
            Ok(ActivationState::Finished) => {
                refund_order(&state, id, &reference, price_ngn, user.id, "no_code").await?;
            }
            Ok(ActivationState::Pending) => {
                // A number nobody answered is still a number we paid for, so the
                // hold is released rather than left to rot in the supplier's pool.
                if expires_at.is_some_and(|t| t < Utc::now()) {
                    let _ = state.numbers.cancel(provider_order_id).await;
                    refund_order(&state, id, &reference, price_ngn, user.id, "expired").await?;
                }
            }
            // A supplier we cannot reach is not a reason to fail the read. The
            // order stays open and the next poll tries again.
            Err(e) => tracing::warn!(error = %e, order_id = %id, "number check failed"),
        }
    }

    load_order(&state, user.id, id).await.map(Json)
}

/// Record everything the number received.
///
/// Failure here is logged rather than propagated: the inbox is a record beside
/// the order, and losing a copy of a message must never stop the order itself
/// from settling — the money side is what the buyer is waiting on.
async fn save_messages(state: &AppState, order_id: Uuid, messages: &[Sms]) {
    for message in messages {
        let result = sqlx::query(
            "INSERT INTO number_messages (order_id, sender, text, code, received_at)
             VALUES ($1, $2, $3, $4, COALESCE($5, now()))
             ON CONFLICT (order_id, text) DO NOTHING",
        )
        .bind(order_id)
        .bind(message.sender.as_deref())
        .bind(&message.text)
        .bind(message.code.as_deref())
        .bind(message.received_at)
        .execute(&state.db)
        .await;

        if let Err(err) = result {
            tracing::warn!(%order_id, error = %err, "could not record a number's message");
        }
    }
}

// ---------------------------------------------------------------------------

/// The code arrived: discharge the reservation into revenue.
async fn settle_order(
    state: &AppState,
    order_id: Uuid,
    reference: &str,
    price_ngn: Decimal,
    code: &str,
    text: &str,
) -> ApiResult<()> {
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;

    let pending_account_id = platform_account(&mut tx, AccountKind::NumberPayablePending).await?;
    let revenue_account_id = platform_account(&mut tx, AccountKind::NumberRevenue).await?;

    let journal = naivolt_ledger::journal::JournalBuilder::new(
        JournalKind::NumberSettle,
        reference.to_owned(),
        format!("{reference}:settle"),
    )
    .entry(
        pending_account_id,
        AccountKind::NumberPayablePending,
        Asset::Ngn,
        price_ngn,
    )
    .entry(
        revenue_account_id,
        AccountKind::NumberRevenue,
        Asset::Ngn,
        -price_ngn,
    )
    .build()
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    let outcome = journal
        .post(&mut tx)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    sqlx::query(
        "UPDATE number_orders
            SET status = 'delivered', sms_code = $2, sms_text = $3, received_at = now(),
                settled_journal_id = $4, updated_at = now()
          WHERE id = $1 AND status IN ('reserved', 'awaiting_code')",
    )
    .bind(order_id)
    .bind(code)
    .bind(text)
    .bind(outcome.journal_id())
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(())
}

/// No code is coming: reverse the reservation.
///
/// This reverses rather than writing a compensating credit, so a user can never
/// end up short by a rounding step or a double refund.
async fn refund_order(
    state: &AppState,
    order_id: Uuid,
    reference: &str,
    price_ngn: Decimal,
    user_id: Uuid,
    reason: &str,
) -> ApiResult<()> {
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;

    let ngn_account_id = lock_user_ngn_account(&mut tx, user_id).await?;
    let pending_account_id = platform_account(&mut tx, AccountKind::NumberPayablePending).await?;

    let journal = naivolt_ledger::journal::JournalBuilder::new(
        JournalKind::NumberRefund,
        reference.to_owned(),
        format!("{reference}:refund"),
    )
    .entry(
        pending_account_id,
        AccountKind::NumberPayablePending,
        Asset::Ngn,
        price_ngn,
    )
    .entry(ngn_account_id, AccountKind::UserNgn, Asset::Ngn, -price_ngn)
    .metadata(serde_json::json!({ "reason": reason }))
    .build()
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    let outcome = journal
        .post(&mut tx)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    let status = if reason == "supplier_unavailable" {
        "failed"
    } else {
        "expired"
    };

    sqlx::query(
        "UPDATE number_orders
            SET status = $2, failure_reason = $3, refunded_journal_id = $4, updated_at = now()
          WHERE id = $1 AND status IN ('reserved', 'awaiting_code')",
    )
    .bind(order_id)
    .bind(status)
    .bind(reason)
    .bind(outcome.journal_id())
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(())
}

/// The columns every order response is built from, and the joins they need.
/// Shared so the list and the single read cannot drift apart.
const ORDER_COLUMNS: &str = "o.id, o.reference, p.name, c.name, c.code, o.price_ngn, \
                             o.status, o.phone_number, o.sms_code, o.expires_at, o.created_at";

const ORDER_FROM: &str = "FROM number_orders o \
                          JOIN number_products  p ON p.id = o.product_id \
                          JOIN number_countries c ON c.id = o.country_id";

type OrderRow = (
    Uuid,
    String,
    String,
    String,
    String,
    Decimal,
    String,
    Option<String>,
    Option<String>,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
);

fn into_response(row: OrderRow) -> OrderResponse {
    let (
        id,
        reference,
        product,
        country,
        country_code,
        price_ngn,
        status,
        phone_number,
        code,
        expires_at,
        created_at,
    ) = row;

    OrderResponse {
        id,
        reference,
        product,
        country,
        country_code,
        price_ngn: price_ngn.normalize().to_string(),
        status,
        phone_number,
        code,
        expires_at: expires_at.map(|t| t.to_rfc3339()),
        created_at: created_at.to_rfc3339(),
        messages: Vec::new(),
    }
}

async fn load_order(state: &AppState, user_id: Uuid, id: Uuid) -> ApiResult<OrderResponse> {
    let row: Option<OrderRow> = sqlx::query_as(&format!(
        "SELECT {ORDER_COLUMNS} {ORDER_FROM} WHERE o.id = $1 AND o.user_id = $2"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    let mut response = row.map(into_response).ok_or(ApiError::NotFound)?;

    let messages: Vec<(Option<String>, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT sender, text, code, received_at
           FROM number_messages WHERE order_id = $1
          ORDER BY received_at",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    response.messages = messages
        .into_iter()
        .map(|(sender, text, code, received_at)| MessageResponse {
            sender,
            text,
            code,
            received_at: received_at.to_rfc3339(),
        })
        .collect();

    Ok(response)
}
