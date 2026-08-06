//! Authenticated reads and the PIN endpoint.
//!
//! Every balance here comes from the **ledger**, never a chain RPC
//! (ARCHITECTURE.md §2). Reading a user's on-chain address balance would drop to
//! zero the moment their wallet is swept, which is exactly the bug the two-plane
//! design exists to prevent.

use crate::error::{ApiError, ApiResult};
use crate::middleware::CurrentUser;
use crate::state::AppState;
use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use naivolt_auth::tier::KycTier;
use naivolt_core::Asset;
use naivolt_ledger::AccountKind;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/me", get(me))
        .route("/auth/pin", post(set_pin))
        .route("/portfolio", get(portfolio))
        .route("/wallets", get(wallets))
        .route("/wallets/deposit-address", get(deposit_address))
        .route("/limits", get(limits))
}

// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub id: Uuid,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub kyc_tier: i16,
    pub has_pin: bool,
    pub can_withdraw: bool,
    pub next_kyc_step: Option<String>,
}

async fn me(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<MeResponse>> {
    let row: (Option<String>, Option<String>, i16, Option<String>) = sqlx::query_as(
        "SELECT phone, email, kyc_tier, pin_hash FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;

    let tier = KycTier::from_i16(row.2).unwrap_or(KycTier::Tier0);

    Ok(Json(MeResponse {
        id: user.id,
        phone: row.0,
        email: row.1,
        kyc_tier: row.2,
        has_pin: row.3.is_some(),
        can_withdraw: tier.can_withdraw(),
        next_kyc_step: tier.next_step().map(str::to_owned),
    }))
}

// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SetPinBody {
    pub pin: String,
}

async fn set_pin(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<SetPinBody>,
) -> ApiResult<Json<serde_json::Value>> {
    // Strength is enforced inside hash_pin, so there is no path that stores a
    // weak PIN even if a caller forgets to validate first.
    let hash = naivolt_auth::hash_pin(&body.pin)
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    sqlx::query("UPDATE users SET pin_hash = $1 WHERE id = $2")
        .bind(&hash)
        .bind(user.id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioResponse {
    /// Decimal strings, never JSON numbers — a double cannot hold NUMERIC(38,18)
    /// and a BTC balance would lose precision on round-trip. See API-CONTRACT §1.
    pub total_ngn: String,
    pub ngn_balance: String,
    pub holdings: Vec<Holding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub asset: String,
    pub balance: String,
}

async fn portfolio(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<PortfolioResponse>> {
    let rows: Vec<(String, String, Decimal)> = sqlx::query_as(
        "SELECT kind, asset, balance FROM ledger_balances
          WHERE user_id = $1 AND kind IN ('user_ngn', 'user_crypto')",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    let mut ngn_balance = Decimal::ZERO;
    let mut holdings = Vec::new();

    for (kind, asset, raw) in rows {
        // Liabilities are stored negative; flip for presentation. Reading the raw
        // sum here would show every user a negative balance.
        let shown = match kind.as_str() {
            "user_ngn" => {
                ngn_balance = AccountKind::UserNgn.user_facing_balance(raw);
                continue;
            }
            "user_crypto" => AccountKind::UserCrypto.user_facing_balance(raw),
            _ => continue,
        };

        if shown > Decimal::ZERO {
            holdings.push(Holding {
                asset,
                balance: shown.normalize().to_string(),
            });
        }
    }

    Ok(Json(PortfolioResponse {
        // Crypto valuation needs the rates service; until it exists the naira
        // balance is the whole of the total, which is also the only figure the
        // app renders (API-CONTRACT §2).
        total_ngn: ngn_balance.normalize().to_string(),
        ngn_balance: ngn_balance.normalize().to_string(),
        holdings,
    }))
}

// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletResponse {
    pub chain: String,
    pub address: String,
}

async fn wallets(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<WalletResponse>>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT chain, address FROM wallets WHERE user_id = $1 ORDER BY chain")
            .bind(user.id)
            .fetch_all(&state.db)
            .await?;

    Ok(Json(
        rows.into_iter()
            .map(|(chain, address)| WalletResponse { chain, address })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct DepositAddressQuery {
    pub asset: String,
    pub chain: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositAddressResponse {
    pub asset: String,
    pub chain: String,
    pub network: String,
    pub address: String,
    pub min_confirmations: u32,
    pub minimum_deposit: String,
}

async fn deposit_address(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<DepositAddressQuery>,
) -> ApiResult<Json<DepositAddressResponse>> {
    let asset: Asset = query
        .asset
        .parse()
        .map_err(|_| ApiError::BadRequest(format!("unknown asset {}", query.asset)))?;

    // The address belongs to the *chain*, and one EVM address serves every EVM
    // network — so the wallet lookup uses the chain family while the response
    // reports the specific network the user chose.
    let (chain, network) = resolve_network(&query.chain)?;

    let address: Option<String> =
        sqlx::query_scalar("SELECT address FROM wallets WHERE user_id = $1 AND chain = $2")
            .bind(user.id)
            .bind(chain.as_str())
            .fetch_optional(&state.db)
            .await?;

    let address = address.ok_or(ApiError::NotFound)?;

    let min_confirmations = confirmations_for(&query.chain, chain);

    Ok(Json(DepositAddressResponse {
        asset: asset.to_string(),
        chain: query.chain,
        network: network.to_owned(),
        address,
        min_confirmations,
        minimum_deposit: minimum_deposit(asset),
    }))
}

fn resolve_network(input: &str) -> ApiResult<(naivolt_core::Chain, &'static str)> {
    use naivolt_core::Chain;
    Ok(match input.to_ascii_lowercase().as_str() {
        "tron" => (Chain::Tron, "TRC-20"),
        "ethereum" => (Chain::Evm, "ERC-20"),
        "bsc" => (Chain::Evm, "BEP-20"),
        "polygon" => (Chain::Evm, "Polygon"),
        "base" => (Chain::Evm, "Base"),
        "bitcoin" => (Chain::Bitcoin, "Bitcoin"),
        "solana" => (Chain::Solana, "Solana"),
        other => return Err(ApiError::BadRequest(format!("unknown network {other}"))),
    })
}

/// Per-network thresholds. `Chain::Evm` covers four networks with very different
/// reorg risk, so the specific network decides rather than the family default.
fn confirmations_for(network: &str, chain: naivolt_core::Chain) -> u32 {
    match network.to_ascii_lowercase().as_str() {
        "ethereum" => 12,
        "bsc" | "polygon" => 20,
        "base" => 10,
        _ => chain.min_confirmations(),
    }
}

fn minimum_deposit(asset: Asset) -> String {
    // Below these, the sweep costs more in gas than the deposit is worth.
    match asset {
        Asset::Usdt | Asset::Usdc => "1",
        Asset::Btc => "0.0001",
        Asset::Eth => "0.005",
        Asset::Bnb => "0.01",
        Asset::Sol => "0.05",
        _ => "0",
    }
    .to_owned()
}

// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsResponse {
    pub kyc_tier: i16,
    pub can_withdraw: bool,
    pub daily_payout_cap: Option<String>,
    pub used_today: String,
    pub remaining_today: Option<String>,
    pub next_step: Option<String>,
}

async fn limits(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<LimitsResponse>> {
    let tier_raw: i16 = sqlx::query_scalar("SELECT kyc_tier FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    let tier = KycTier::from_i16(tier_raw).unwrap_or(KycTier::Tier0);

    let used: Option<Decimal> =
        sqlx::query_scalar("SELECT used_ngn FROM payout_usage_24h WHERE user_id = $1")
            .bind(user.id)
            .fetch_optional(&state.db)
            .await?;
    let used = used.unwrap_or(Decimal::ZERO);

    let cap = tier.daily_payout_cap();

    Ok(Json(LimitsResponse {
        kyc_tier: tier_raw,
        can_withdraw: tier.can_withdraw(),
        daily_payout_cap: cap.map(|c| c.normalize().to_string()),
        used_today: used.normalize().to_string(),
        // Never negative: if limits were lowered after a payout, used can exceed
        // the cap, and "-₦10,000 remaining" is not something to show a user.
        remaining_today: cap.map(|c| (c - used).max(Decimal::ZERO).normalize().to_string()),
        next_step: tier.next_step().map(str::to_owned),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use naivolt_core::Chain;

    #[test]
    fn every_evm_network_maps_to_one_address_but_its_own_confirmations() {
        for (network, expected) in [("ethereum", 12), ("bsc", 20), ("polygon", 20), ("base", 10)] {
            let (chain, _) = resolve_network(network).unwrap();
            assert_eq!(chain, Chain::Evm, "{network} should share the EVM wallet");
            assert_eq!(
                confirmations_for(network, chain),
                expected,
                "{network} confirmations"
            );
        }
    }

    #[test]
    fn network_labels_match_what_sending_wallets_show() {
        // Users think in "TRC-20" and "BEP-20" because that is what their sending
        // wallet calls them; a mismatch here is how funds go to the wrong chain.
        assert_eq!(resolve_network("tron").unwrap().1, "TRC-20");
        assert_eq!(resolve_network("bsc").unwrap().1, "BEP-20");
        assert_eq!(resolve_network("ethereum").unwrap().1, "ERC-20");
    }

    #[test]
    fn unknown_networks_are_rejected() {
        assert!(resolve_network("dogechain").is_err());
    }
}
