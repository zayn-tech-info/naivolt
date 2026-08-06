//! Rates and the margin.
//!
//! This is the module the client used to be. The app shipped its own CoinGecko
//! fetch and spread arithmetic so the screens had real numbers before this
//! existed; that had to move here before anything touches real money, for two
//! reasons. A margin computed on the device is readable by anyone who unpacks
//! the bundle, and — the one that matters — it cannot be *enforced*. Only the
//! server issuing a quote can guarantee the price it will honour.
//!
//! ## Why USD, not CoinGecko's NGN
//!
//! CoinGecko will return `vs_currency=ngn`, but that figure is derived from the
//! *official* USD/NGN rate. It prices USDT around ₦1,364 while the parallel
//! market — the rate every Nigerian actually trades at, and the one competitors
//! quote — sits well above it. Pricing off it would make us look ~10-12% worse
//! on every asset. So we take the USD price, which is a real deep-market number,
//! and apply our own naira rate.
//!
//! ## Why the margin is per dollar, not per coin
//!
//! One BTC is worth ~64,000 USDT. A flat naira margin *per coin* earns ₦10 on a
//! ₦98,000,000 BTC sale (0.00001%) while charging ~2% on TRX. Charged per dollar
//! of value, one constant lands identically on every asset — see the test below.

use crate::config::Config;
use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// Serve cached prices within this window rather than refetching.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// Past this, a cached price is refused rather than quoted.
///
/// A stale price is dangerous in a way a missing one is not: quoting off a
/// twenty-minute-old figure can mean buying above market. ARCHITECTURE.md §9
/// freezes quoting rather than guessing, and this is that rule.
const STALE_LIMIT: Duration = Duration::from_secs(5 * 60);

const ENDPOINT: &str = "https://api.coingecko.com/api/v3/simple/price";

/// Assets we price, and their CoinGecko ids.
const COINGECKO_IDS: &[(&str, &str)] = &[
    ("BTC", "bitcoin"),
    ("ETH", "ethereum"),
    ("USDT", "tether"),
    ("USDC", "usd-coin"),
    ("BNB", "binancecoin"),
    ("SOL", "solana"),
    ("TRX", "tron"),
];

#[derive(Debug, Deserialize)]
struct CoinGeckoQuote {
    usd: Option<f64>,
    usd_24h_change: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct AssetPrice {
    pub asset: String,
    pub usd_price: Decimal,
    /// Naira per unit, margin already deducted.
    pub ngn_rate: Decimal,
    pub change_pct_24h: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct RateBoard {
    /// Net naira per US dollar — the headline, and the pricing primitive.
    pub ngn_per_usd: Decimal,
    pub assets: Vec<AssetPrice>,
    pub as_of: chrono::DateTime<chrono::Utc>,
}

struct CacheEntry {
    /// Raw USD prices, before any margin. Cached pre-margin so a config change
    /// takes effect immediately rather than waiting out the TTL.
    usd: HashMap<String, (Decimal, Option<f64>)>,
    fetched_at: Instant,
    as_of: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone)]
pub struct Rates {
    http: reqwest::Client,
    cache: Arc<RwLock<Option<CacheEntry>>>,
    mid_ngn_per_usd: Decimal,
    spread_ngn_per_usd: Decimal,
}

#[derive(Debug, thiserror::Error)]
pub enum RateError {
    #[error("no price fresh enough to quote against")]
    Unavailable,
}

impl Rates {
    pub fn new(config: &Config) -> Self {
        Self {
            http: reqwest::Client::builder()
                // CoinGecko's free tier can hang rather than fail fast; without a
                // timeout a stalled request holds the request handler open.
                .timeout(Duration::from_secs(8))
                // Required, not cosmetic: CoinGecko answers 403 to any request
                // with no User-Agent, and reqwest sends none by default. Without
                // this every price fetch fails and the app shows no rates.
                .user_agent(concat!("naivolt-api/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default(),
            cache: Arc::new(RwLock::new(None)),
            mid_ngn_per_usd: config.usd_ngn_mid,
            spread_ngn_per_usd: config.spread_ngn_per_usd,
        }
    }

    /// What we pay per dollar of value: mid less our margin.
    ///
    /// Clamped at zero so a misconfigured spread larger than the rate itself
    /// cannot produce a negative payout.
    pub fn net_ngn_per_usd(&self) -> Decimal {
        (self.mid_ngn_per_usd - self.spread_ngn_per_usd).max(Decimal::ZERO)
    }

    /// Naira we pay per unit of an asset.
    pub fn ngn_rate_for(&self, usd_price: Decimal) -> Decimal {
        (usd_price * self.net_ngn_per_usd()).max(Decimal::ZERO)
    }

    pub async fn board(&self) -> Result<RateBoard, RateError> {
        let (usd, as_of) = self.prices().await?;
        let ngn_per_usd = self.net_ngn_per_usd();

        let mut assets: Vec<AssetPrice> = usd
            .into_iter()
            .map(|(asset, (usd_price, change))| AssetPrice {
                asset,
                usd_price,
                ngn_rate: self.ngn_rate_for(usd_price),
                change_pct_24h: change,
            })
            .filter(|row| row.ngn_rate > Decimal::ZERO)
            .collect();

        // Highest value first — BTC at the top reads as a price list.
        assets.sort_by(|a, b| b.usd_price.cmp(&a.usd_price));

        Ok(RateBoard {
            ngn_per_usd,
            assets,
            as_of,
        })
    }

    /// Net naira rate for one asset, for valuing a balance.
    pub async fn ngn_rate_of(&self, asset: &str) -> Option<Decimal> {
        let (usd, _) = self.prices().await.ok()?;
        usd.get(asset).map(|(price, _)| self.ngn_rate_for(*price))
    }

    async fn prices(
        &self,
    ) -> Result<
        (
            HashMap<String, (Decimal, Option<f64>)>,
            chrono::DateTime<chrono::Utc>,
        ),
        RateError,
    > {
        if let Some(entry) = self.cache.read().await.as_ref() {
            if entry.fetched_at.elapsed() < CACHE_TTL {
                return Ok((entry.usd.clone(), entry.as_of));
            }
        }

        match self.fetch().await {
            Ok(fresh) => {
                let as_of = chrono::Utc::now();
                *self.cache.write().await = Some(CacheEntry {
                    usd: fresh.clone(),
                    fetched_at: Instant::now(),
                    as_of,
                });
                Ok((fresh, as_of))
            }
            Err(err) => {
                // Serve a recent-but-stale price rather than failing outright;
                // refuse once it is old enough that quoting off it is a real risk.
                let guard = self.cache.read().await;
                match guard.as_ref() {
                    Some(entry) if entry.fetched_at.elapsed() < STALE_LIMIT => {
                        tracing::warn!(error = %err, "serving stale prices");
                        Ok((entry.usd.clone(), entry.as_of))
                    }
                    _ => {
                        tracing::error!(error = %err, "no usable prices");
                        Err(RateError::Unavailable)
                    }
                }
            }
        }
    }

    async fn fetch(&self) -> anyhow::Result<HashMap<String, (Decimal, Option<f64>)>> {
        let ids = COINGECKO_IDS
            .iter()
            .map(|(_, id)| *id)
            .collect::<Vec<_>>()
            .join(",");

        let body: HashMap<String, CoinGeckoQuote> = self
            .http
            .get(ENDPOINT)
            .query(&[
                ("ids", ids.as_str()),
                ("vs_currencies", "usd"),
                ("include_24hr_change", "true"),
            ])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let mut out = HashMap::new();
        for (asset, id) in COINGECKO_IDS {
            let Some(quote) = body.get(*id) else { continue };
            let Some(usd) = quote.usd else { continue };
            // Skip rather than default to zero: a zero price would render as a
            // real rate of ₦0 and let someone sell into it.
            if usd <= 0.0 {
                continue;
            }
            let Some(price) = Decimal::from_f64(usd) else {
                continue;
            };
            out.insert(asset.to_string(), (price, quote.usd_24h_change));
        }

        if out.is_empty() {
            anyhow::bail!("CoinGecko returned no usable prices");
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn rates(mid: Decimal, spread: Decimal) -> Rates {
        Rates {
            http: reqwest::Client::new(),
            cache: Arc::new(RwLock::new(None)),
            mid_ngn_per_usd: mid,
            spread_ngn_per_usd: spread,
        }
    }

    #[test]
    fn the_user_is_always_paid_less_than_mid() {
        let r = rates(dec!(1530), dec!(10));
        assert!(r.net_ngn_per_usd() < dec!(1530));
    }

    #[test]
    fn a_spread_larger_than_the_rate_cannot_produce_a_negative_payout() {
        let r = rates(dec!(5), dec!(10));
        assert_eq!(r.net_ngn_per_usd(), Decimal::ZERO);
        assert_eq!(r.ngn_rate_for(dec!(64000)), Decimal::ZERO);
    }

    /// The property the whole per-dollar model exists for. A per-coin margin
    /// would earn wildly different amounts across these; this must not.
    #[test]
    fn the_margin_is_identical_across_five_orders_of_magnitude() {
        let r = rates(dec!(1530), dec!(10));
        let sale_ngn = dec!(1000000);

        let margins: Vec<Decimal> = [dec!(64000), dec!(1900), dec!(570), dec!(73), dec!(1), dec!(0.325)]
            .into_iter()
            .map(|usd_price| {
                let net = r.ngn_rate_for(usd_price);
                let mid = usd_price * r.mid_ngn_per_usd;
                // Units the user sells to receive sale_ngn at our rate, valued
                // at mid — the difference is our margin.
                let units = sale_ngn / net;
                units * mid - sale_ngn
            })
            .collect();

        for margin in &margins {
            let delta = (*margin - margins[0]).abs();
            assert!(delta < dec!(0.01), "margin drifted: {margin} vs {}", margins[0]);
        }
    }

    #[test]
    fn margin_does_not_collapse_on_high_value_assets() {
        // Regression guard for the per-coin model this replaced, which earned
        // 0.00001% on BTC.
        let r = rates(dec!(1530), dec!(10));
        let mid = dec!(64000) * r.mid_ngn_per_usd;
        let net = r.ngn_rate_for(dec!(64000));
        let pct = (mid - net) / mid;
        assert!(pct > dec!(0.0001), "margin collapsed to {pct}");
    }
}
