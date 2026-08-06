//! Gift cards — the app's primary earner.
//!
//! A manual review flow, deliberately. Unlike a crypto deposit, a gift card
//! cannot be verified by a machine: someone checks it and approves it. So a
//! submission lands as `pending` and **naira is credited only on approval**.
//! Crediting on submit would mean paying out for cards that turn out to be empty
//! or already redeemed, which is the loss this queue exists to prevent.
//!
//! The rate is captured onto the submission at the moment it is made. A user
//! agreed to a number; a later rate change must not alter what they are paid.

use crate::error::{ApiError, ApiResult};
use crate::middleware::CurrentUser;
use crate::state::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/gift-cards/brands", get(brands))
        .route("/gift-cards/submissions", post(submit))
}

// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftCardBrand {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub logo_url: Option<String>,
    pub requires_image: bool,
    pub has_pin: bool,
    pub note: Option<String>,
    pub rates: Vec<GiftCardRate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftCardRate {
    pub country_code: String,
    pub country_name: String,
    pub currency: String,
    pub rate_per_unit: String,
    pub min_face_value: String,
    pub max_face_value: String,
}

async fn brands(State(state): State<AppState>) -> ApiResult<Json<Vec<GiftCardBrand>>> {
    // One query, joined, rather than N+1 per brand.
    let rows: Vec<(
        Uuid,
        String,
        String,
        Option<String>,
        bool,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Decimal>,
        Option<Decimal>,
        Option<Decimal>,
    )> = sqlx::query_as(
        "SELECT b.id, b.name, b.slug, b.logo_url, b.requires_image, b.has_pin, b.note,
                r.country_code, r.country_name, r.currency,
                r.rate_per_unit, r.min_face_value, r.max_face_value
           FROM gift_card_brands b
           LEFT JOIN gift_card_rates r ON r.brand_id = b.id AND r.active
          WHERE b.active
          ORDER BY b.name, r.rate_per_unit DESC",
    )
    .fetch_all(&state.db)
    .await?;

    let mut brands: Vec<GiftCardBrand> = Vec::new();
    for row in rows {
        let (id, name, slug, logo_url, requires_image, has_pin, note, cc, cn, cur, rate, min, max) =
            row;

        if brands.last().map(|b| b.id) != Some(id) {
            brands.push(GiftCardBrand {
                id,
                name,
                slug,
                logo_url,
                requires_image,
                has_pin,
                note,
                rates: Vec::new(),
            });
        }

        // LEFT JOIN: a brand with no active rate still appears, with an empty
        // list. The client renders it as "rate on request" rather than hiding a
        // brand whose rates are being retuned.
        if let (Some(cc), Some(cn), Some(cur), Some(rate), Some(min), Some(max)) =
            (cc, cn, cur, rate, min, max)
        {
            if let Some(brand) = brands.last_mut() {
                brand.rates.push(GiftCardRate {
                    country_code: cc,
                    country_name: cn,
                    currency: cur,
                    rate_per_unit: rate.normalize().to_string(),
                    min_face_value: min.normalize().to_string(),
                    max_face_value: max.normalize().to_string(),
                });
            }
        }
    }

    Ok(Json(brands))
}

// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitBody {
    pub brand_id: Uuid,
    pub country_code: String,
    pub face_value: String,
    pub card_code: String,
    pub card_pin: Option<String>,
    /// URL of an already-uploaded image. Multipart upload is handled separately;
    /// this endpoint takes JSON so the card details are not spread across two
    /// content types.
    pub image_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionResponse {
    pub id: Uuid,
    pub brand_name: String,
    pub country_code: String,
    pub face_value: String,
    pub currency: String,
    pub payout_ngn: String,
    pub status: String,
    pub reference: String,
    pub created_at: String,
}

async fn submit(
    State(state): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
    Json(body): Json<SubmitBody>,
) -> ApiResult<Json<SubmissionResponse>> {
    let idempotency_key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::BadRequest("Idempotency-Key header is required".into()))?;

    // A replay returns the original rather than queuing the same physical card
    // twice for review.
    if let Some(existing) = find_by_key(&state, user.id, &idempotency_key).await? {
        return Ok(Json(existing));
    }

    let face_value = Decimal::from_str(body.face_value.trim())
        .map_err(|_| ApiError::BadRequest("That amount isn't a number.".into()))?;
    if face_value <= Decimal::ZERO {
        return Err(ApiError::BadRequest("Enter the value printed on the card.".into()));
    }

    if body.card_code.trim().is_empty() {
        return Err(ApiError::BadRequest("Enter the card code.".into()));
    }

    let rate: Option<(Uuid, String, String, Decimal, Decimal, Decimal, bool, String)> =
        sqlx::query_as(
            "SELECT r.id, r.currency, r.country_name, r.rate_per_unit,
                    r.min_face_value, r.max_face_value, b.requires_image, b.name
               FROM gift_card_rates r
               JOIN gift_card_brands b ON b.id = r.brand_id
              WHERE r.brand_id = $1 AND r.country_code = $2 AND r.active AND b.active",
        )
        .bind(body.brand_id)
        .bind(&body.country_code)
        .fetch_optional(&state.db)
        .await?;

    let (rate_id, currency, _country_name, rate_per_unit, min_face, max_face, requires_image, brand_name) =
        rate.ok_or_else(|| {
            ApiError::BadRequest("We don't buy that card from there right now.".into())
        })?;

    if face_value < min_face {
        return Err(ApiError::BadRequest(format!(
            "Minimum for {brand_name} is {currency} {}.",
            min_face.normalize()
        )));
    }
    if face_value > max_face {
        return Err(ApiError::BadRequest(format!(
            "Maximum for {brand_name} is {currency} {}.",
            max_face.normalize()
        )));
    }
    if requires_image && body.image_url.as_deref().unwrap_or("").trim().is_empty() {
        return Err(ApiError::BadRequest("A photo of the card is required.".into()));
    }

    let payout_ngn = (face_value * rate_per_unit).round_dp(4);
    let reference = format!("NVGC-{}", &Uuid::new_v4().simple().to_string()[..10].to_uppercase());

    let (id, created_at): (Uuid, chrono::DateTime<chrono::Utc>) = sqlx::query_as(
        "INSERT INTO gift_card_submissions
           (user_id, brand_id, rate_id, face_value, currency, rate_per_unit, payout_ngn,
            card_code, card_pin, image_url, reference, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, created_at",
    )
    .bind(user.id)
    .bind(body.brand_id)
    .bind(rate_id)
    .bind(face_value)
    .bind(&currency)
    .bind(rate_per_unit)
    .bind(payout_ngn)
    .bind(body.card_code.trim())
    .bind(body.card_pin.as_deref().map(str::trim))
    .bind(body.image_url.as_deref())
    .bind(&reference)
    .bind(&idempotency_key)
    .fetch_one(&state.db)
    .await?;

    // Note what did NOT happen here: no ledger entry. The user's balance moves
    // on approval, not on submission.
    Ok(Json(SubmissionResponse {
        id,
        brand_name,
        country_code: body.country_code,
        face_value: face_value.normalize().to_string(),
        currency,
        payout_ngn: payout_ngn.normalize().to_string(),
        status: "pending".into(),
        reference,
        created_at: created_at.to_rfc3339(),
    }))
}

async fn find_by_key(
    state: &AppState,
    user_id: Uuid,
    key: &str,
) -> ApiResult<Option<SubmissionResponse>> {
    let row: Option<(
        Uuid,
        String,
        Decimal,
        String,
        Decimal,
        String,
        String,
        chrono::DateTime<chrono::Utc>,
        String,
    )> = sqlx::query_as(
        "SELECT s.id, b.name, s.face_value, s.currency, s.payout_ngn, s.status, s.reference,
                s.created_at, r.country_code
           FROM gift_card_submissions s
           JOIN gift_card_brands b ON b.id = s.brand_id
           JOIN gift_card_rates r ON r.id = s.rate_id
          WHERE s.idempotency_key = $1 AND s.user_id = $2",
    )
    .bind(key)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;

    Ok(row.map(
        |(id, brand_name, face_value, currency, payout_ngn, status, reference, created_at, country_code)| {
            SubmissionResponse {
                id,
                brand_name,
                country_code,
                face_value: face_value.normalize().to_string(),
                currency,
                payout_ngn: payout_ngn.normalize().to_string(),
                status,
                reference,
                created_at: created_at.to_rfc3339(),
            }
        },
    ))
}

// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTokenBody {
    pub token: String,
    pub device_id: String,
    pub platform: String,
}

pub fn push_routes() -> Router<AppState> {
    Router::new().route("/devices/push-token", post(register_push_token))
}

async fn register_push_token(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<PushTokenBody>,
) -> ApiResult<Json<serde_json::Value>> {
    if !matches!(body.platform.as_str(), "ios" | "android") {
        return Err(ApiError::BadRequest("unknown platform".into()));
    }
    if body.token.trim().is_empty() || body.device_id.trim().is_empty() {
        return Err(ApiError::BadRequest("token and deviceId are required".into()));
    }

    // Keyed on (user, device): re-registering the same installation replaces its
    // token rather than accumulating dead ones. Tokens rotate on reinstall, and
    // pushing to a stale token is how a provider starts rate-limiting you.
    sqlx::query(
        "INSERT INTO device_push_tokens (user_id, device_id, token, platform)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, device_id)
         DO UPDATE SET token = EXCLUDED.token,
                       platform = EXCLUDED.platform,
                       updated_at = now()",
    )
    .bind(user.id)
    .bind(body.device_id.trim())
    .bind(body.token.trim())
    .bind(&body.platform)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
