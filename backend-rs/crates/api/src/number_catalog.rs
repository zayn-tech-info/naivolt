//! Keeping the number catalogue in step with the supplier.
//!
//! `number_prices` used to be a hand-written table: 72 rows, `stock` left at 0
//! on every one of them and `provider_cost` never filled in. The catalogue
//! endpoint reads `in_stock: stock > 0`, so every number on the dashboard was
//! showing as unavailable, and nothing in the system knew what any of them cost
//! us. Both facts came from the same missing piece — this.
//!
//! 5SIM's *guest* endpoints need no API key, so the catalogue is live in
//! development too, and one request per country returns every product's stock
//! and price at once:
//!
//! ```text
//! GET /v1/guest/products/nigeria/any
//! {"whatsapp":{"Category":"activation","Qty":1554232,"Price":0.28}, …}
//! ```
//!
//! ## The price is derived, not typed
//!
//! A hand-set naira price goes stale silently and in the dangerous direction:
//! 5SIM had moved US WhatsApp to $0.90 (≈₦1,395) while the table still said
//! ₦1,010, so every US sale lost money and nothing said so. The sale price is
//! now the supplier's own price times a margin, which cannot drift below cost.
//!
//! ## The unit is dollars
//!
//! 5SIM quotes a bare number and never names the currency, which is why
//! `FIVESIM_CURRENCY` exists. The guest API settles it by arithmetic: US
//! WhatsApp at 0.90 and Instagram at 0.06 are only coherent as dollars — no
//! activation anywhere costs six hundredths of a rouble. A configured currency
//! that is not USD is therefore believed over this assumption, and the sync
//! records cost and stock but leaves pricing alone rather than converting
//! through a rate it was never given.

use crate::state::AppState;
use rust_decimal::Decimal;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

const GUEST_PRODUCTS: &str = "https://5sim.net/v1/guest/products";

/// Stock moves constantly; price barely does. This is paced for price.
const INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Ignore a recomputed price this close to the stored one.
///
/// Without it a supplier's ordinary cent-level jitter rewrites the whole table
/// every five minutes, and a price can move between the page a user is reading
/// and the order they place from it.
const PRICE_HYSTERESIS: Decimal = Decimal::from_parts(5, 0, 0, false, 2); // 0.05

/// We sell one-shot activations. 5SIM also lists rentals and hosting under the
/// same names, at prices that would be nonsense charged for a single code.
const ACTIVATION: &str = "activation";

/// No number sells for less than this, whatever the arithmetic says.
const MIN_PRICE_NGN: i64 = 100;

/// What the sale price is built from.
#[derive(Clone)]
pub struct Pricing {
    /// Naira per dollar — what it costs us to hold the supplier float.
    pub usd_ngn: Decimal,
    /// Multiple of supplier cost charged to the user.
    pub margin: Decimal,
    /// The unit the supplier quotes in, if it was stated.
    pub supplier_currency: Option<String>,
}

impl Pricing {
    /// Whether costs can be turned into naira at all.
    fn prices_in_usd(&self) -> bool {
        match &self.supplier_currency {
            Some(currency) => currency.eq_ignore_ascii_case("USD"),
            None => true,
        }
    }

    /// Sale price for a supplier cost, rounded up to the nearest ₦10.
    ///
    /// Up, not to nearest: rounding down is a margin cut taken 72 rows at a time.
    fn sale_price(&self, cost: Decimal) -> Decimal {
        let ten = Decimal::from(10);
        let raw = cost * self.usd_ngn * self.margin;
        let rounded = (raw / ten).ceil() * ten;
        rounded.max(Decimal::from(MIN_PRICE_NGN))
    }
}

#[derive(Debug, Deserialize)]
struct GuestProduct {
    #[serde(rename = "Category")]
    category: String,
    #[serde(rename = "Qty")]
    qty: i64,
    #[serde(rename = "Price")]
    price: Decimal,
}

pub fn spawn(state: AppState, pricing: Pricing) {
    if !pricing.prices_in_usd() {
        tracing::warn!(
            currency = ?pricing.supplier_currency,
            "FIVESIM_CURRENCY is not USD — stock will sync but prices stay as set, \
             because converting through a rate we were never given would be a guess"
        );
    }

    tokio::spawn(async move {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default();

        loop {
            match sync(&state, &pricing, &http).await {
                Ok(report) => tracing::info!(
                    countries = report.countries,
                    updated = report.updated,
                    repriced = report.repriced,
                    out_of_stock = report.out_of_stock,
                    "number catalogue synced"
                ),
                // Leave the last known catalogue in place. A supplier we cannot
                // reach is not a supplier with nothing in stock, and zeroing the
                // table on a failed fetch would empty the shop.
                Err(err) => tracing::warn!(error = ?err, "number catalogue sync failed"),
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

#[derive(Default)]
pub struct SyncReport {
    pub countries: usize,
    pub updated: usize,
    pub repriced: usize,
    pub out_of_stock: usize,
}

pub async fn sync(
    state: &AppState,
    pricing: &Pricing,
    http: &reqwest::Client,
) -> anyhow::Result<SyncReport> {
    let countries: Vec<(Uuid, String, String)> =
        sqlx::query_as("SELECT id, code, provider_country FROM number_countries WHERE active")
            .fetch_all(&state.db)
            .await?;
    let products: Vec<(Uuid, String, String)> =
        sqlx::query_as("SELECT id, slug, provider_product FROM number_products WHERE active")
            .fetch_all(&state.db)
            .await?;

    let mut report = SyncReport::default();

    for (country_id, country_code, provider_country) in &countries {
        let url = format!("{GUEST_PRODUCTS}/{provider_country}/any");
        let listing: HashMap<String, GuestProduct> = match http.get(&url).send().await {
            Ok(response) if response.status().is_success() => match response.json().await {
                Ok(listing) => listing,
                Err(err) => {
                    tracing::warn!(%country_code, error = %err, "5sim listing was unreadable");
                    continue;
                }
            },
            Ok(response) => {
                tracing::warn!(%country_code, status = %response.status(), "5sim listing refused");
                continue;
            }
            Err(err) => {
                tracing::warn!(%country_code, error = %err, "5sim listing unreachable");
                continue;
            }
        };
        report.countries += 1;

        for (product_id, slug, provider_product) in &products {
            let offer = listing
                .get(provider_product)
                .filter(|offer| offer.category == ACTIVATION);

            let (stock, cost) = match offer {
                Some(offer) => (offer.qty.max(0) as i32, Some(offer.price)),
                // Not offered here today. Recording zero is the honest answer —
                // the catalogue reads `in_stock` from it — and the price stays
                // put so the row is ready when it comes back.
                None => (0, None),
            };
            if stock == 0 {
                report.out_of_stock += 1;
            }

            let stored: Option<(Decimal, Option<Decimal>)> = sqlx::query_as(
                "SELECT price_ngn, provider_cost FROM number_prices
                  WHERE product_id = $1 AND country_id = $2",
            )
            .bind(product_id)
            .bind(country_id)
            .fetch_optional(&state.db)
            .await?;

            let new_price = match (cost, pricing.prices_in_usd()) {
                (Some(cost), true) => {
                    let candidate = pricing.sale_price(cost);
                    match stored.as_ref().map(|(price, _)| *price) {
                        // Hold the current price through ordinary supplier
                        // jitter, so the number a user is looking at is still
                        // that price when they buy it.
                        Some(current)
                            if current > Decimal::ZERO
                                && ((candidate - current) / current).abs() < PRICE_HYSTERESIS =>
                        {
                            current
                        }
                        Some(current) => {
                            if current != candidate {
                                report.repriced += 1;
                                tracing::info!(
                                    %slug, %country_code, %current, %candidate, %cost,
                                    "number repriced from supplier cost"
                                );
                            }
                            candidate
                        }
                        None => candidate,
                    }
                }
                // No cost to price from, or a currency we cannot convert.
                _ => match stored.as_ref().map(|(price, _)| *price) {
                    Some(current) => current,
                    None => continue,
                },
            };

            sqlx::query(
                "INSERT INTO number_prices
                    (product_id, country_id, price_ngn, provider_cost,
                     provider_cost_currency, provider_operator, stock, synced_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'any', $6, now(), now())
                 ON CONFLICT (product_id, country_id) DO UPDATE
                    SET price_ngn = EXCLUDED.price_ngn,
                        provider_cost = COALESCE(EXCLUDED.provider_cost, number_prices.provider_cost),
                        provider_cost_currency = EXCLUDED.provider_cost_currency,
                        provider_operator = EXCLUDED.provider_operator,
                        stock = EXCLUDED.stock,
                        synced_at = now(),
                        updated_at = now()",
            )
            .bind(product_id)
            .bind(country_id)
            .bind(new_price)
            .bind(cost)
            .bind(
                pricing
                    .supplier_currency
                    .clone()
                    .unwrap_or_else(|| "USD".to_owned()),
            )
            .bind(stock)
            .execute(&state.db)
            .await?;

            report.updated += 1;
        }
    }

    if report.countries == 0 {
        anyhow::bail!("no country listing could be read from 5sim");
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn pricing() -> Pricing {
        Pricing {
            usd_ngn: dec!(1530),
            margin: dec!(1.6),
            supplier_currency: None,
        }
    }

    #[test]
    fn a_sale_price_always_clears_the_supplier_cost() {
        // The failure this exists to prevent: US WhatsApp cost $0.90 while the
        // hand-set table charged ₦1,010, a loss of ~₦380 on every sale.
        let pricing = pricing();
        for cost in [dec!(0.06), dec!(0.28), dec!(0.9), dec!(1.9231)] {
            let price = pricing.sale_price(cost);
            assert!(
                price > cost * pricing.usd_ngn,
                "{cost} priced at {price}, below cost"
            );
        }
    }

    #[test]
    fn prices_round_up_to_ten_naira() {
        // Rounding to nearest would give away the margin on the cheap rows,
        // which are most of them.
        let pricing = pricing();
        assert_eq!(pricing.sale_price(dec!(0.28)), dec!(690)); // 685.44 → 690
        assert_eq!(pricing.sale_price(dec!(0.9)), dec!(2210)); // 2203.2 → 2210
    }

    #[test]
    fn nothing_sells_for_less_than_a_hundred_naira() {
        // 5SIM's floor is a couple of cents; the arithmetic alone would put a
        // number on sale for ₦20.
        assert_eq!(pricing().sale_price(dec!(0.001)), dec!(100));
    }

    #[test]
    fn a_supplier_currency_that_is_not_usd_stops_pricing() {
        // Converting roubles at a dollar rate would misprice the whole table by
        // roughly ninety times.
        let rub = Pricing {
            supplier_currency: Some("RUB".into()),
            ..pricing()
        };
        assert!(!rub.prices_in_usd());
        assert!(pricing().prices_in_usd());
        assert!(Pricing {
            supplier_currency: Some("usd".into()),
            ..pricing()
        }
        .prices_in_usd());
    }
}
