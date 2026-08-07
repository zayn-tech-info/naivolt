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
        .route("/me", get(me).patch(update_me))
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
    /// What the user chose to be called. Never the KYC legal name.
    pub display_name: Option<String>,
    /// Seed for the generated avatar. Stable per user unless they shuffle it.
    pub avatar_seed: Option<String>,
    /// ISO date. Held here so verification never re-asks for it.
    pub date_of_birth: Option<String>,
    /// Everything verification needs, minus the ID number itself.
    pub profile_complete: bool,
    pub kyc_tier: i16,
    pub has_pin: bool,
    pub can_withdraw: bool,
    pub next_kyc_step: Option<String>,
}

async fn me(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<MeResponse>> {
    let row: (
        Option<String>,
        Option<String>,
        i16,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<chrono::NaiveDate>,
    ) = sqlx::query_as(
        "SELECT phone, email, kyc_tier, pin_hash, display_name, avatar_seed, date_of_birth
           FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;

    let tier = KycTier::from_i16(row.2).unwrap_or(KycTier::Tier0);

    Ok(Json(MeResponse {
        id: user.id,
        phone: row.0,
        email: row.1,
        display_name: row.4.clone(),
        avatar_seed: row.5,
        date_of_birth: row.6.map(|d| d.to_string()),
        // The client uses this to decide whether verification can be a single
        // field or has to collect the rest first.
        profile_complete: row.4.as_deref().map(|n| n.split_whitespace().count() >= 2)
            == Some(true)
            && row.6.is_some(),
        kyc_tier: row.2,
        has_pin: row.3.is_some(),
        can_withdraw: tier.can_withdraw(),
        next_kyc_step: tier.next_step().map(str::to_owned),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeBody {
    pub display_name: Option<String>,
    pub avatar_seed: Option<String>,
    /// Added by phone-signup users, who have no email until they choose to give
    /// one. Verification and receipts both want it.
    pub email: Option<String>,
    /// ISO date, YYYY-MM-DD. Held on the user so verification does not have to
    /// ask for it again at every tier.
    pub date_of_birth: Option<String>,
}

/// Updates the profile fields a user owns.
///
/// Deliberately narrow. Phone, email, tier and address index are all either
/// identity or derived state, and none of them may be changed by a PATCH from
/// the device — a writable `kyc_tier` here would hand every account an unlimited
/// withdrawal cap.
async fn update_me(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<UpdateMeBody>,
) -> ApiResult<Json<MeResponse>> {
    if let Some(name) = &body.display_name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(ApiError::BadRequest("Enter a name.".into()));
        }
        // Long enough for a real Nigerian full name, short enough that it cannot
        // be used to smuggle a paragraph into every screen that greets them.
        if trimmed.chars().count() > 60 {
            return Err(ApiError::BadRequest("That name is too long.".into()));
        }
    }

    // Deliberately permissive. Anything past "one @ with something either side"
    // rejects addresses that actually work, and the only proof that an address
    // is real is sending to it — which the OTP flow already does.
    if let Some(email) = &body.email {
        let trimmed = email.trim();
        let valid = trimmed.len() >= 3
            && trimmed.matches('@').count() == 1
            && !trimmed.starts_with('@')
            && !trimmed.ends_with('@')
            && !trimmed.contains(' ');
        if !valid {
            return Err(ApiError::BadRequest("That email doesn't look right.".into()));
        }
    }

    let dob = match &body.date_of_birth {
        Some(raw) => {
            let parsed = chrono::NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d")
                .map_err(|_| ApiError::BadRequest("Enter your date of birth as YYYY-MM-DD.".into()))?;
            // 18 is the floor for holding a Nigerian bank account, so anyone
            // below it could never receive a payout however well we verify them.
            let age = (chrono::Utc::now().date_naive() - parsed).num_days() / 365;
            if age < 18 {
                return Err(ApiError::BadRequest("You must be 18 or older.".into()));
            }
            if age > 120 {
                return Err(ApiError::BadRequest("Check that date of birth.".into()));
            }
            Some(parsed)
        }
        None => None,
    };

    let result = sqlx::query(
        "UPDATE users
            SET display_name  = COALESCE($1, display_name),
                avatar_seed   = COALESCE($2, avatar_seed),
                email         = COALESCE($3, email),
                date_of_birth = COALESCE($4, date_of_birth)
          WHERE id = $5",
    )
    .bind(body.display_name.as_deref().map(str::trim))
    .bind(body.avatar_seed.as_deref().map(str::trim))
    .bind(body.email.as_deref().map(|e| e.trim().to_lowercase()))
    .bind(dob)
    .bind(user.id)
    .execute(&state.db)
    .await;

    if let Err(err) = result {
        // users.email is UNIQUE. Another account holding this address is a
        // conflict the user can act on, not an internal error.
        if let Some(db_err) = err.as_database_error() {
            if db_err.is_unique_violation() {
                return Err(ApiError::BadRequest(
                    "That email is already on another account.".into(),
                ));
            }
        }
        return Err(ApiError::Internal(err.into()));
    }

    me(State(state), user).await
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
    /// The only field the app renders. Home headlines it and Withdraw calls it
    /// "Available" — the same number by design, so the app can never show a
    /// balance larger than what the user can actually send to their bank.
    pub ngn_balance: String,
    pub holdings: Vec<Holding>,
    /// Not computed. Null rather than 0, so the client hides the indicator
    /// instead of claiming a flat day (API-CONTRACT §2).
    pub change_pct24h: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    pub asset: String,
    pub balance: String,
    /// Value at the current sell rate. "0" when we cannot price the asset —
    /// never omitted, so the client never has to guess.
    pub ngn_value: String,
    pub rate: String,
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
    let mut crypto_total = Decimal::ZERO;

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
            // Valued server-side so the client never applies a margin. An asset
            // we cannot price contributes zero rather than blocking the whole
            // portfolio read — a balance the user can see is worth more than a
            // spinner while CoinGecko is down.
            let rate = state.rates.ngn_rate_of(&asset).await.unwrap_or(Decimal::ZERO);
            let value = (shown * rate).round_dp(4);
            crypto_total += value;

            holdings.push(Holding {
                asset,
                balance: shown.normalize().to_string(),
                ngn_value: value.normalize().to_string(),
                rate: rate.round_dp(4).normalize().to_string(),
            });
        }
    }

    Ok(Json(PortfolioResponse {
        total_ngn: (ngn_balance + crypto_total).normalize().to_string(),
        ngn_balance: ngn_balance.normalize().to_string(),
        holdings,
        change_pct24h: None,
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

/// Below this a transfer costs more in provider fees than it moves.
const MIN_WITHDRAWAL_NGN: i64 = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsResponse {
    pub kyc_tier: i16,
    pub can_withdraw: bool,
    pub daily_payout_cap: Option<String>,
    pub used_today: String,
    pub remaining_today: Option<String>,
    pub next_step: Option<String>,

    // The names the withdraw screen validates against (API-CONTRACT §5). They
    // duplicate the fields above rather than replacing them because the tier
    // detail is what the KYC prompts read, and the client wants flat numbers it
    // can compare an amount to without knowing about tiers.
    //
    // A tier that cannot withdraw reports zero rather than null: the form treats
    // a missing cap as "no limit", and an unverified user must not see an
    // unlimited field.
    pub daily_limit_ngn: String,
    pub daily_remaining_ngn: String,
    pub per_transaction_max_ngn: String,
    pub min_withdrawal_ngn: String,
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

    let remaining = cap.map(|c| (c - used).max(Decimal::ZERO)).unwrap_or(Decimal::ZERO);

    Ok(Json(LimitsResponse {
        kyc_tier: tier_raw,
        can_withdraw: tier.can_withdraw(),
        daily_payout_cap: cap.map(|c| c.normalize().to_string()),
        used_today: used.normalize().to_string(),
        // Never negative: if limits were lowered after a payout, used can exceed
        // the cap, and "-₦10,000 remaining" is not something to show a user.
        remaining_today: cap.map(|c| (c - used).max(Decimal::ZERO).normalize().to_string()),
        next_step: tier.next_step().map(str::to_owned),

        daily_limit_ngn: cap.unwrap_or(Decimal::ZERO).normalize().to_string(),
        daily_remaining_ngn: remaining.normalize().to_string(),
        // A single transfer can use the whole daily allowance; the cap that
        // actually binds is the daily one, so this mirrors it rather than
        // inventing a second threshold the backend does not enforce.
        per_transaction_max_ngn: cap.unwrap_or(Decimal::ZERO).normalize().to_string(),
        min_withdrawal_ngn: MIN_WITHDRAWAL_NGN.to_string(),
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
