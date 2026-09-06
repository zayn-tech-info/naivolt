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
use crate::number_order_transitions::{self, OrderTransition, RefundStatus};
use crate::number_provider::{ActivationState, PurchaseError};
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
        .route("/numbers/orders/:id/cancel", post(cancel_order))
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

#[derive(Clone, Deserialize)]
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
        .ok_or_else(|| ApiError::BadRequest("Idempotency-Key header is required".into()))?;
    let idempotency_key = Uuid::parse_str(idempotency_key)
        .map_err(|_| ApiError::BadRequest("Idempotency-Key must be a UUID".into()))?;

    let expected_price_ngn = body
        .expected_price_ngn
        .as_deref()
        .map(|value| Decimal::from_str(value.trim()))
        .transpose()
        .map_err(|_| ApiError::BadRequest("That expected price isn't a number.".into()))?;
    // --- Reserve, under a row lock -------------------------------------------
    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;

    let ngn_account_id = lock_user_ngn_account(&mut tx, user.id).await?;

    let existing: Option<(Uuid, String, String, Option<Decimal>, bool)> = sqlx::query_as(
        "SELECT o.id, p.slug, c.code, o.expected_price_ngn, o.idempotency_payload_complete
           FROM number_orders o
           JOIN number_products p ON p.id = o.product_id
           JOIN number_countries c ON c.id = o.country_id
           LEFT JOIN ledger_journals j ON j.id = o.reserved_journal_id
          WHERE o.user_id = $1
            AND (o.idempotency_key = $2
                 OR (o.idempotency_key IS NULL AND j.idempotency_key = $3))
          LIMIT 1",
    )
    .bind(user.id)
    .bind(idempotency_key)
    .bind(idempotency_key.to_string())
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    if let Some((id, stored_product, stored_country, stored_expected, complete)) = existing {
        if stored_product != body.product_slug.trim().to_lowercase()
            || stored_country != body.country_code.trim().to_uppercase()
            || (complete && stored_expected != expected_price_ngn)
        {
            return Err(ApiError::Conflict(
                "That Idempotency-Key belongs to a different number purchase.".into(),
            ));
        }
        tx.commit().await.map_err(anyhow::Error::from)?;
        return load_order(&state, user.id, id).await.map(Json);
    }

    let (product_id, _product_name, provider_product): (Uuid, String, String) = sqlx::query_as(
        "SELECT id, name, provider_product FROM number_products WHERE slug = $1 AND active",
    )
    .bind(body.product_slug.trim().to_lowercase())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::BadRequest("We don't sell numbers for that app.".into()))?;

    let (country_id, _country_name, provider_country): (Uuid, String, String) = sqlx::query_as(
        "SELECT id, name, provider_country FROM number_countries WHERE code = $1 AND active",
    )
    .bind(body.country_code.trim().to_uppercase())
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::BadRequest("We don't sell numbers in that country.".into()))?;

    let price_ngn: Decimal = sqlx::query_scalar(
        "SELECT price_ngn FROM number_prices
          WHERE product_id = $1 AND country_id = $2 AND active",
    )
    .bind(product_id)
    .bind(country_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::BadRequest("That app isn't available in that country yet.".into()))?;

    // This availability gate applies only to a new purchase. Replays return
    // their stored result even when provider configuration changes later.
    if !state.numbers.is_live() && state.funding.is_live() {
        return Err(ApiError::ServiceUnavailable(
            "Numbers aren't on sale yet. Nothing has been charged.".into(),
        ));
    }

    if let Some(expected) = expected_price_ngn {
        // Only a new purchase is price checked. A replay returns its stored
        // order even when the live catalogue price has moved since the commit.
        if price_ngn > expected {
            return Err(ApiError::PriceMoved {
                price_ngn: price_ngn.normalize().to_string(),
            });
        }
    }

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
    let reference = format!(
        "NVNO-{}",
        &Uuid::new_v4().simple().to_string()[..10].to_uppercase()
    );

    // Until the closing migration, keep writing the raw UUID understood by
    // the previous API binary. Once 0015 makes the order key required, every
    // serving process is known to understand user-scoped reservation keys.
    let order_keys_required: bool = sqlx::query_scalar(
        "SELECT attnotnull
           FROM pg_attribute
          WHERE attrelid = 'number_orders'::regclass
            AND attname = 'idempotency_key'
            AND NOT attisdropped",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    let reservation_key = if order_keys_required {
        format!("number-reserve:{}:{idempotency_key}", user.id)
    } else {
        idempotency_key.to_string()
    };

    let journal = naivolt_ledger::journal::JournalBuilder::new(
        JournalKind::NumberReserve,
        reference.clone(),
        reservation_key,
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

    let (order_id, _created_at): (Uuid, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO number_orders
           (user_id, product_id, country_id, price_ngn, provider, status, reference,
            reserved_journal_id, idempotency_key, expected_price_ngn,
            idempotency_payload_complete, reconciliation_payload_complete, reconcile_next_at)
         VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7, $8, $9, true, true, now() + interval '5 seconds')
         RETURNING id, created_at",
    )
    .bind(user.id)
    .bind(product_id)
    .bind(country_id)
    .bind(price_ngn)
    .bind(if state.numbers.is_live() { "5sim" } else { "stub" })
    .bind(&reference)
    .bind(outcome.journal_id())
    .bind(idempotency_key)
    .bind(expected_price_ngn)
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    tx.commit().await.map_err(anyhow::Error::from)?;

    let claim_token = Uuid::new_v4();
    let claimed = sqlx::query(
        "UPDATE number_orders SET provider_purchase_started_at = now(),
                reconcile_claim_token = $2, reconcile_claimed_until = now() + interval '60 seconds', updated_at = now()
          WHERE id = $1 AND status = 'reserved' AND provider_purchase_started_at IS NULL
            AND (reconcile_claimed_until IS NULL OR reconcile_claimed_until < now())")
        .bind(order_id).bind(claim_token).execute(&state.db).await?;
    if claimed.rows_affected() != 1 {
        return load_order(&state, user.id, order_id).await.map(Json);
    }

    let activation = match state
        .numbers
        .buy(&provider_country, &provider_product)
        .await
    {
        Ok(activation) => activation,
        Err(PurchaseError::Rejected(err)) => {
            number_order_transitions::apply_claimed(
                &state.db,
                order_id,
                claim_token,
                OrderTransition::Refund {
                    status: RefundStatus::Failed,
                    reason: "supplier_rejected".into(),
                },
            )
            .await?;
            return Err(err);
        }
        Err(PurchaseError::Ambiguous) => {
            crate::number_reconciler::mark_review_required(
                &state.db,
                order_id,
                claim_token,
                "purchase_outcome_unknown",
            )
            .await?;
            return load_order(&state, user.id, order_id).await.map(Json);
        }
    };

    let assigned = sqlx::query(
        "UPDATE number_orders
            SET status = 'awaiting_code', provider_order_id = $2, phone_number = $3,
                provider_cost = $4, provider_cost_currency = $5,
                expires_at = COALESCE($6, now() + interval '15 minutes'),
                reconcile_next_at = now() + interval '10 seconds',
                reconcile_claim_token = NULL, reconcile_claimed_until = NULL,
                updated_at = now()
          WHERE id = $1 AND status = 'reserved' AND reconcile_claim_token = $7 AND reconcile_claimed_until > now()",
    )
    .bind(order_id)
    .bind(&activation.provider_order_id)
    .bind(&activation.phone)
    .bind(activation.cost)
    .bind(activation.cost_currency.as_deref())
    .bind(activation.expires_at)
    .bind(claim_token)
    .execute(&state.db)
    .await?;

    if assigned.rows_affected() != 1 {
        if state.numbers.is_live() {
            let _ = state.numbers.cancel(&activation.provider_order_id).await;
        }
        return load_order(&state, user.id, order_id).await.map(Json);
    }

    load_order(&state, user.id, order_id).await.map(Json)
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

/// Reads the stored order. Supplier state is owned by the reconciler.
async fn get_order(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<OrderResponse>> {
    load_order(&state, user.id, id).await.map(Json)
}

/// Give a number back before its twenty minutes are up.
///
/// Without this, a user watching a number that will plainly never receive
/// anything waits out the full hold to get their money back. The refund is the
/// same one expiry performs — the reservation reverses, so no rounding step or
/// double refund can leave anyone short.
///
/// A code that already arrived is not cancellable. The order was fulfilled, the
/// money is revenue, and the number is spent.
async fn cancel_order(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<OrderResponse>> {
    let row: Option<(String, Option<String>, Decimal, String)> = sqlx::query_as(
        "SELECT status, provider_order_id, price_ngn, reference
           FROM number_orders WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;

    let (status, provider_order_id, _price_ngn, _reference) = row.ok_or(ApiError::NotFound)?;

    if !matches!(status.as_str(), "reserved" | "awaiting_code") {
        return load_order(&state, user.id, id).await.map(Json);
    }

    // Ask the supplier whether a code already exists before refunding. A cancel
    // that wins after SMS arrived at 5SIM would refund the customer while we
    // still paid for the number. Terminal transitions stay serialized; this
    // chooses the right terminal.
    if let Some(provider_order_id) = provider_order_id.as_deref() {
        match state.numbers.check(provider_order_id).await {
            Ok(ActivationState::Received {
                code,
                text,
                messages,
            }) => {
                number_order_transitions::deliver(&state.db, id, code, text, &messages).await?;
                return load_order(&state, user.id, id).await.map(Json);
            }
            Ok(ActivationState::Finished) => {}
            Ok(ActivationState::Pending) => {
                if state.numbers.is_live() {
                    if let Err(error) = state.numbers.cancel(provider_order_id).await {
                        tracing::warn!(order = %id, error = %error, "supplier refused cancel");
                        let current = load_order(&state, user.id, id).await?;
                        if !matches!(current.status.as_str(), "reserved" | "awaiting_code") {
                            return Ok(Json(current));
                        }
                        return Err(ApiError::ServiceUnavailable(
                            "That number can't be released just yet — try again in a moment."
                                .into(),
                        ));
                    }
                }
            }
            Err(_) => {
                let current = load_order(&state, user.id, id).await?;
                if !matches!(current.status.as_str(), "reserved" | "awaiting_code") {
                    return Ok(Json(current));
                }
                return Err(ApiError::ServiceUnavailable(
                    "We couldn't check that number just now.".into(),
                ));
            }
        }
    }

    number_order_transitions::apply(
        &state.db,
        id,
        OrderTransition::Refund {
            status: RefundStatus::Cancelled,
            reason: "cancelled".into(),
        },
    )
    .await?;
    load_order(&state, user.id, id).await.map(Json)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, Environment};
    use crate::funding_provider::{AnyFundingProvider, StubFunding};
    use crate::google_keys::GoogleKeys;
    use crate::notify::{AnyNotifier, LogNotifier};
    use crate::number_provider::{AnyNumberProvider, CountingStubProvider, ScriptedStubProvider};
    use crate::payout_provider;
    use crate::pricing::Rates;
    use crate::signer::{AnyAddressProvider, LocalSigner};
    use crate::test_database::IsolatedDatabase;
    use naivolt_auth::session::SessionKeys;
    use rust_decimal_macros::dec;
    use std::sync::Arc;

    fn test_config() -> Config {
        Config {
            environment: Environment::Development,
            bind_addr: "127.0.0.1:0".into(),
            database_url: String::new(),
            jwt_secret: "01234567890123456789012345678901".into(),
            termii_api_key: None,
            termii_sender_id: "Naivolt".into(),
            resend_api_key: None,
            operations_alert_email: None,
            email_from: "test@example.test".into(),
            signer_url: None,
            dev_mnemonic: None,
            auto_approve_kyc: false,
            dev_otp_code: None,
            paystack_secret_key: None,
            google_client_id: None,
            fivesim_api_key: None,
            fivesim_currency: Some("USD".into()),
            google_allowed_emails: Vec::new(),
            admin_token: None,
            web_app_url: "http://localhost".into(),
            numbers_margin: dec!(1.25),
            usd_ngn_mid: dec!(1600),
            spread_ngn_per_usd: dec!(20),
        }
    }

    #[tokio::test]
    async fn concurrent_purchase_replay_calls_supplier_once() {
        let database = IsolatedDatabase::new("number_purchase_test").await;
        let pool = database.pool.clone();
        let user_id: Uuid = sqlx::query_scalar(
            "INSERT INTO users (email) VALUES ('purchase-race@example.test') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let user_account: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_accounts (kind, user_id, asset)
             VALUES ('user_ngn', $1, 'NGN') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let float_account: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_accounts (kind, asset)
             VALUES ('naira_bank_float', 'NGN') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let funding_journal: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_journals (kind, reference, idempotency_key)
             VALUES ('ngn_funding', 'purchase-race-funding', 'purchase-race-funding') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let mut funding = pool.begin().await.unwrap();
        sqlx::query(
            "INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
             VALUES ($1, $2, 'NGN', -100000), ($1, $3, 'NGN', 100000)",
        )
        .bind(funding_journal)
        .bind(user_account)
        .bind(float_account)
        .execute(&mut *funding)
        .await
        .unwrap();
        funding.commit().await.unwrap();

        let provider = CountingStubProvider::default();
        let config = test_config();
        let state = AppState {
            db: pool.clone(),
            keys: Arc::new(SessionKeys::from_secret(config.jwt_secret.as_bytes()).unwrap()),
            notifier: Arc::new(AnyNotifier::Log(LogNotifier)),
            addresses: Arc::new(AnyAddressProvider::Local(
                LocalSigner::from_mnemonic(
                    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
                )
                .unwrap(),
            )),
            rates: Rates::new(&config),
            payouts: Arc::new(payout_provider::AnyPayoutProvider::Stub(
                payout_provider::StubProvider,
            )),
            numbers: Arc::new(AnyNumberProvider::CountingStub(provider.clone())),
            funding: Arc::new(AnyFundingProvider::Stub(StubFunding)),
            google_keys: Arc::new(GoogleKeys::new()),
            google_client_id: None,
            dev_otp_code: None,
            auto_approve_kyc: false,
            google_allowed_emails: Arc::new(Vec::new()),
            admin_token: None,
            operations_alert_email: None,
            web_app_url: "http://localhost".into(),
        };
        let (product_slug, country_code, price): (String, String, Decimal) = sqlx::query_as(
            "SELECT p.slug, c.code, pr.price_ngn FROM number_prices pr
             JOIN number_products p ON p.id = pr.product_id
             JOIN number_countries c ON c.id = pr.country_id
             WHERE pr.active AND p.active AND c.active ORDER BY p.id, c.id LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let key = Uuid::new_v4().to_string();
        let request = CreateOrderBody {
            product_slug,
            country_code,
            expected_price_ngn: Some(price.normalize().to_string()),
        };
        let mut headers = HeaderMap::new();
        headers.insert("Idempotency-Key", key.parse().unwrap());
        let replay_headers = headers.clone();
        let replay_request = request.clone();
        let user = || CurrentUser {
            id: user_id,
            tier_at_issue: 0,
            session_family: Uuid::new_v4(),
        };
        let first = create_order(
            State(state.clone()),
            user(),
            headers.clone(),
            Json(request.clone()),
        );
        let second = create_order(State(state.clone()), user(), headers, Json(request.clone()));
        let (first, second) = tokio::join!(first, second);
        let first = first.unwrap().0;
        let second = second.unwrap().0;
        assert_eq!(first.id, second.id);
        assert_eq!(provider.buy_calls(), 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM number_orders WHERE user_id = $1")
                .bind(user_id)
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM ledger_journals WHERE kind = 'number_reserve'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT idempotency_key FROM ledger_journals WHERE kind = 'number_reserve'",
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            format!("number-reserve:{user_id}:{key}")
        );

        sqlx::query("UPDATE number_prices SET active = false")
            .execute(&pool)
            .await
            .unwrap();
        let inactive_replay = create_order(
            State(state.clone()),
            user(),
            replay_headers,
            Json(replay_request),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(inactive_replay.id, first.id);
        assert_eq!(provider.buy_calls(), 1);

        sqlx::query("UPDATE number_prices SET active = true")
            .execute(&pool)
            .await
            .unwrap();
        let legacy_key = Uuid::new_v4();
        let legacy_reference = "NVNO-LEGACY-OVERLAP";
        let legacy_reservation: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_journals (kind, reference, idempotency_key)
             VALUES ('number_reserve', $1, $2) RETURNING id",
        )
        .bind(legacy_reference)
        .bind(legacy_key.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        let pending_account: Uuid = sqlx::query_scalar(
            "SELECT id FROM ledger_accounts
             WHERE kind = 'number_payable_pending' AND user_id IS NULL AND asset = 'NGN'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let mut legacy_tx = pool.begin().await.unwrap();
        sqlx::query(
            "INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
             VALUES ($1, $2, 'NGN', $4), ($1, $3, 'NGN', -$4)",
        )
        .bind(legacy_reservation)
        .bind(user_account)
        .bind(pending_account)
        .bind(price)
        .execute(&mut *legacy_tx)
        .await
        .unwrap();
        legacy_tx.commit().await.unwrap();
        let legacy_order: Uuid = sqlx::query_scalar(
            "INSERT INTO number_orders (
                 user_id, product_id, country_id, price_ngn, status, reference,
                 reserved_journal_id, idempotency_key, idempotency_payload_complete
             )
             SELECT $1, p.id, c.id, $2, 'reserved', $3, $4, $7, false
               FROM number_products p, number_countries c
              WHERE p.slug = $5 AND c.code = $6
             RETURNING id",
        )
        .bind(user_id)
        .bind(price)
        .bind(legacy_reference)
        .bind(legacy_reservation)
        .bind(&request.product_slug)
        .bind(&request.country_code)
        .bind(legacy_key)
        .fetch_one(&pool)
        .await
        .unwrap();
        let mut legacy_headers = HeaderMap::new();
        legacy_headers.insert("Idempotency-Key", legacy_key.to_string().parse().unwrap());
        let legacy_replay = create_order(
            State(state.clone()),
            user(),
            legacy_headers,
            Json(request.clone()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(legacy_replay.id, legacy_order);
        assert_eq!(provider.buy_calls(), 1);

        sqlx::query(
            "UPDATE number_orders o
                SET idempotency_key = j.idempotency_key::UUID
               FROM ledger_journals j
              WHERE o.reserved_journal_id = j.id AND o.idempotency_key IS NULL",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("ALTER TABLE number_orders ALTER COLUMN idempotency_key SET NOT NULL")
            .execute(&pool)
            .await
            .unwrap();

        let closed_key = Uuid::new_v4();
        let mut closed_headers = HeaderMap::new();
        closed_headers.insert("Idempotency-Key", closed_key.to_string().parse().unwrap());
        let _ = create_order(State(state), user(), closed_headers, Json(request))
            .await
            .unwrap();
        assert_eq!(provider.buy_calls(), 2);
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT idempotency_key
                   FROM ledger_journals
                  WHERE idempotency_key = $1",
            )
            .bind(format!("number-reserve:{user_id}:{closed_key}"))
            .fetch_one(&pool)
            .await
            .unwrap(),
            format!("number-reserve:{user_id}:{closed_key}")
        );

        database.cleanup().await;
    }

    fn test_state(pool: sqlx::PgPool, numbers: AnyNumberProvider) -> AppState {
        let config = test_config();
        AppState {
            db: pool,
            keys: Arc::new(SessionKeys::from_secret(config.jwt_secret.as_bytes()).unwrap()),
            notifier: Arc::new(AnyNotifier::Log(LogNotifier)),
            addresses: Arc::new(AnyAddressProvider::Local(
                LocalSigner::from_mnemonic(
                    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
                )
                .unwrap(),
            )),
            rates: Rates::new(&config),
            payouts: Arc::new(payout_provider::AnyPayoutProvider::Stub(
                payout_provider::StubProvider,
            )),
            numbers: Arc::new(numbers),
            funding: Arc::new(AnyFundingProvider::Stub(StubFunding)),
            google_keys: Arc::new(GoogleKeys::new()),
            google_client_id: None,
            dev_otp_code: None,
            auto_approve_kyc: false,
            google_allowed_emails: Arc::new(Vec::new()),
            admin_token: None,
            operations_alert_email: None,
            web_app_url: "http://localhost".into(),
        }
    }

    async fn awaiting_code_order(pool: &sqlx::PgPool, suffix: &str) -> (Uuid, Uuid) {
        use sqlx::Executor;
        let user_id: Uuid = sqlx::query_scalar("INSERT INTO users (email) VALUES ($1) RETURNING id")
            .bind(format!("cancel-{suffix}@example.test"))
            .fetch_one(pool)
            .await
            .unwrap();
        let user_account: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_accounts (kind, user_id, asset)
             VALUES ('user_ngn', $1, 'NGN') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap();
        pool.execute(
            "INSERT INTO ledger_accounts (kind, asset) VALUES ('number_payable_pending', 'NGN')
             ON CONFLICT DO NOTHING;
             INSERT INTO ledger_accounts (kind, asset) VALUES ('number_revenue', 'NGN')
             ON CONFLICT DO NOTHING",
        )
        .await
        .unwrap();
        let pending: Uuid = sqlx::query_scalar(
            "SELECT id FROM ledger_accounts WHERE kind = 'number_payable_pending' AND asset = 'NGN'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        let reference = format!("NVNO-CANCEL-{suffix}");
        let reserve_id: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_journals (kind, reference, idempotency_key)
             VALUES ('number_reserve', $1, $2) RETURNING id",
        )
        .bind(&reference)
        .bind(format!("reserve-cancel-{suffix}"))
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
             VALUES ($1, $2, 'NGN', 500), ($1, $3, 'NGN', -500)",
        )
        .bind(reserve_id)
        .bind(user_account)
        .bind(pending)
        .execute(pool)
        .await
        .unwrap();
        let order_id: Uuid = sqlx::query_scalar(
            "INSERT INTO number_orders (
                user_id, product_id, country_id, price_ngn, status, reference,
                reserved_journal_id, idempotency_key, idempotency_payload_complete,
                provider_order_id, reconciliation_payload_complete
             )
             SELECT $1, p.id, c.id, 500, 'awaiting_code', $2, $3, $4, true, $5, true
               FROM number_products p, number_countries c
              ORDER BY p.id, c.id LIMIT 1
             RETURNING id",
        )
        .bind(user_id)
        .bind(reference)
        .bind(reserve_id)
        .bind(Uuid::new_v4())
        .bind(format!("provider-{suffix}"))
        .fetch_one(pool)
        .await
        .unwrap();
        (user_id, order_id)
    }

    #[tokio::test]
    async fn cancel_delivers_when_the_supplier_already_has_sms() {
        let database = IsolatedDatabase::new("number_cancel_received_test").await;
        let (user_id, order_id) = awaiting_code_order(&database.pool, "RECV").await;
        let state = test_state(
            database.pool.clone(),
            AnyNumberProvider::ScriptedStub(ScriptedStubProvider::received()),
        );
        let response = cancel_order(State(state), CurrentUser {
            id: user_id,
            tier_at_issue: 0,
            session_family: Uuid::new_v4(),
        }, Path(order_id))
        .await
        .unwrap()
        .0;
        assert_eq!(response.status, "delivered");
        assert_eq!(response.code.as_deref(), Some("123456"));
        let journals: (i64, i64) = sqlx::query_as(
            "SELECT
                (CASE WHEN settled_journal_id IS NOT NULL THEN 1 ELSE 0 END)::BIGINT,
                (CASE WHEN refunded_journal_id IS NOT NULL THEN 1 ELSE 0 END)::BIGINT
               FROM number_orders WHERE id = $1",
        )
        .bind(order_id)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(journals, (1, 0));
        database.cleanup().await;
    }

    #[tokio::test]
    async fn cancel_refunds_when_the_supplier_is_still_pending() {
        let database = IsolatedDatabase::new("number_cancel_pending_test").await;
        let (user_id, order_id) = awaiting_code_order(&database.pool, "PEND").await;
        let state = test_state(
            database.pool.clone(),
            AnyNumberProvider::ScriptedStub(ScriptedStubProvider::pending()),
        );
        let response = cancel_order(State(state), CurrentUser {
            id: user_id,
            tier_at_issue: 0,
            session_family: Uuid::new_v4(),
        }, Path(order_id))
        .await
        .unwrap()
        .0;
        assert_eq!(response.status, "cancelled");
        let journals: (i64, i64) = sqlx::query_as(
            "SELECT
                (CASE WHEN settled_journal_id IS NOT NULL THEN 1 ELSE 0 END)::BIGINT,
                (CASE WHEN refunded_journal_id IS NOT NULL THEN 1 ELSE 0 END)::BIGINT
               FROM number_orders WHERE id = $1",
        )
        .bind(order_id)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(journals, (0, 1));
        database.cleanup().await;
    }

    #[tokio::test]
    async fn cancel_does_not_refund_when_supplier_check_fails() {
        let database = IsolatedDatabase::new("number_cancel_check_fail_test").await;
        let (user_id, order_id) = awaiting_code_order(&database.pool, "FAIL").await;
        let state = test_state(
            database.pool.clone(),
            AnyNumberProvider::ScriptedStub(ScriptedStubProvider::failing()),
        );
        let err = match cancel_order(State(state), CurrentUser {
            id: user_id,
            tier_at_issue: 0,
            session_family: Uuid::new_v4(),
        }, Path(order_id))
        .await
        {
            Ok(_) => panic!("expected supplier check failure to keep the order open"),
            Err(error) => error,
        };
        assert!(matches!(err, ApiError::ServiceUnavailable(_)));
        let status: String = sqlx::query_scalar("SELECT status FROM number_orders WHERE id = $1")
            .bind(order_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
        assert_eq!(status, "awaiting_code");
        database.cleanup().await;
    }
}
