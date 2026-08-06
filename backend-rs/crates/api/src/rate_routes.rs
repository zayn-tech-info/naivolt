//! The rates board.
//!
//! Public, unlike everything else in the app — a rate is not user data, and
//! someone deciding whether to sign up should be able to see what we pay before
//! they do.
//!
//! What leaves here is **net** only: the naira-per-dollar rate we honour and each
//! asset's market price. There is deliberately no mid rate and no spread field.
//! The app quotes one number and pays exactly that number; our margin is embedded
//! rather than itemised, which is how every exchange quotes. A mid rate on this
//! payload is also a value some screen eventually renders by accident.

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

pub fn routes() -> Router<AppState> {
    Router::new().route("/rates", get(rates))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateBoardResponse {
    /// Net naira per US dollar — the headline, and the pricing primitive. Every
    /// asset's `rate` below is this times its `usdPrice`.
    pub ngn_per_usd: String,
    pub as_of: String,
    pub assets: Vec<AssetRateResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRateResponse {
    pub asset: String,
    /// Market price in USD — the real deep-market number the client leads with.
    pub usd_price: String,
    /// Naira per unit, margin already deducted.
    pub rate: String,
    /// Null rather than 0 when unavailable, so the client hides the indicator
    /// instead of claiming a flat day.
    pub change_pct_24h: Option<f64>,
}

async fn rates(State(state): State<AppState>) -> ApiResult<Json<RateBoardResponse>> {
    let board = state.rates.board().await.map_err(|_| {
        // Quoting freezes rather than guessing (ARCHITECTURE.md §9). The client
        // renders this as "rates unavailable" and disables selling.
        ApiError::ServiceUnavailable("Rates are unavailable right now.".into())
    })?;

    Ok(Json(RateBoardResponse {
        ngn_per_usd: board.ngn_per_usd.normalize().to_string(),
        as_of: board.as_of.to_rfc3339(),
        assets: board
            .assets
            .into_iter()
            .map(|row| AssetRateResponse {
                asset: row.asset,
                usd_price: row.usd_price.normalize().to_string(),
                rate: row.ngn_rate.round_dp(4).normalize().to_string(),
                change_pct_24h: row.change_pct_24h,
            })
            .collect(),
    }))
}
