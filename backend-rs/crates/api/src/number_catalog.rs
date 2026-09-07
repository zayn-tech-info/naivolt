//! Keeping the number catalogue in step with the supplier.
//!
//! `number_prices` began as 72 hand-written rows with `stock` left at 0 on every
//! one of them. The catalogue endpoint reads `in_stock: stock > 0`, so every
//! number on the dashboard showed as unavailable, and `provider_cost` was never
//! filled in, so nothing knew what any of them cost us.
//!
//! It is no longer a list anyone types. 5SIM offers **153 countries** and, per
//! country, between 200 and 779 products — about a thousand services in total.
//! The sync reads the supplier's own country list and per-country product list
//! and inserts what it finds, so a service 5SIM adds tomorrow is on sale here
//! without a migration.
//!
//! ```text
//! GET /v1/guest/countries
//! {"nigeria":{"iso":{"ng":1},"prefix":{"+234":1},"text_en":"Nigeria"}, …}
//!
//! GET /v1/guest/products/nigeria/any
//! {"whatsapp":{"Category":"activation","Qty":1554232,"Price":0.28}, …}
//! ```
//!
//! Guest endpoints need no API key, so the catalogue is live in development too.
//!
//! ## The price is derived, not typed
//!
//! A hand-set naira price goes stale in the dangerous direction: 5SIM moved US
//! WhatsApp to $0.90 (≈₦1,395) while the table still said ₦1,010, so every US
//! sale lost money and nothing said so. Price is the supplier's cost times a
//! margin, which cannot drift below cost.
//!
//! ## The unit is dollars
//!
//! 5SIM quotes a bare number and never names the currency. US WhatsApp at 0.90
//! and Instagram at 0.06 are only coherent as dollars — no activation anywhere
//! costs six hundredths of a rouble. `FIVESIM_CURRENCY` is believed over that
//! inference: set to anything but USD, the sync records stock and cost but
//! leaves pricing alone rather than converting through a rate it was never given.

use crate::number_offers::{self, OfferSku};
use crate::number_smspool::SmsPoolProvider;
use crate::state::AppState;
use rust_decimal::Decimal;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

const GUEST_COUNTRIES: &str = "https://5sim.net/v1/guest/countries";
const GUEST_PRODUCTS: &str = "https://5sim.net/v1/guest/products";

/// A full sweep is 153 requests. Stock moves constantly, price barely does, and
/// this is paced for price — and for staying welcome on an unauthenticated API.
const INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Between countries, so a sweep is a trickle rather than a burst.
const REQUEST_SPACING: Duration = Duration::from_millis(150);

/// Ignore a recomputed price this close to the stored one. Without it the
/// supplier's cent-level jitter rewrites tens of thousands of rows every sweep,
/// and a price can move between the page a user is reading and the order they
/// place from it.
const PRICE_HYSTERESIS: &str = "0.05";

/// We sell one-shot activations. 5SIM lists rentals and hosting under the same
/// names at prices that would be nonsense charged for a single code.
const ACTIVATION: &str = "activation";

/// No number sells for less than this, whatever the arithmetic says.
const MIN_PRICE_NGN: i64 = 100;

/// What a number sells for.
#[derive(Clone)]
pub struct Pricing {
    /// Naira per dollar — what it costs us to hold the supplier float.
    pub usd_ngn: Decimal,
    /// Multiple of supplier cost charged to the user.
    pub margin: Decimal,
    /// The unit the supplier quotes in, if it was stated.
    pub supplier_currency: Option<String>,
}

pub struct OfferSync {
    pub write_stub: bool,
    pub smspool: Option<SmsPoolProvider>,
    pub smspool_pricing: Pricing,
}

impl Pricing {
    /// Whether costs can be turned into naira at all.
    pub(crate) fn prices_in_usd(&self) -> bool {
        match &self.supplier_currency {
            Some(currency) => currency.eq_ignore_ascii_case("USD"),
            None => true,
        }
    }

    /// Sale price for a supplier cost, rounded up to the nearest ₦10.
    ///
    /// Up, not to nearest: rounding down is a margin cut taken tens of thousands
    /// of rows at a time.
    pub(crate) fn sale_price(&self, cost: Decimal) -> Decimal {
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
    #[serde(default, rename = "Rate")]
    rate: Option<serde_json::Value>,
    #[serde(default)]
    success: Option<serde_json::Value>,
}

/// 5SIM's country entry. `iso` and `prefix` are objects keyed by the value —
/// `{"ng": 1}` — rather than plain strings, so the key is the datum.
#[derive(Debug, Deserialize)]
struct GuestCountry {
    #[serde(default)]
    iso: HashMap<String, serde_json::Value>,
    #[serde(default)]
    prefix: HashMap<String, serde_json::Value>,
    #[serde(default)]
    text_en: Option<String>,
}

pub fn spawn(state: AppState, pricing: Pricing, offers: OfferSync) {
    if !pricing.prices_in_usd() {
        tracing::warn!(
            currency = ?pricing.supplier_currency,
            "FIVESIM_CURRENCY is not USD — stock will sync but prices stay as set, \
             because converting through a rate we were never given would be a guess"
        );
    }

    tokio::spawn(async move {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        loop {
            match sync(&state, &pricing, &http).await {
                Ok((report, fivesim_skus)) => {
                    tracing::info!(
                        countries = report.countries,
                        products = report.products,
                        rows = report.rows,
                        in_stock = report.in_stock,
                        "number catalogue synced"
                    );
                    if let Err(err) =
                        sync_offers(&state, &pricing, &offers, Some(fivesim_skus)).await
                    {
                        tracing::warn!(error = ?err, "number offers sync failed");
                    }
                }
                // Leave the last known catalogue in place. A supplier we cannot
                // reach is not a supplier with nothing in stock, and zeroing the
                // table on a failed fetch would empty the shop.
                Err(err) => {
                    tracing::warn!(error = ?err, "number catalogue sync failed");
                    if let Err(err) = sync_offers(&state, &pricing, &offers, None).await {
                        tracing::warn!(error = ?err, "number offers sync failed");
                    }
                }
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

#[derive(Default)]
pub struct SyncReport {
    pub countries: usize,
    pub products: usize,
    pub rows: usize,
    pub in_stock: usize,
}

pub async fn sync(
    state: &AppState,
    pricing: &Pricing,
    http: &reqwest::Client,
) -> anyhow::Result<(SyncReport, Vec<OfferSku>)> {
    let countries: HashMap<String, GuestCountry> = http
        .get(GUEST_COUNTRIES)
        .send()
        .await?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("country list unreadable: {e}"))?;

    let mut report = SyncReport::default();
    let mut fivesim_skus = Vec::new();

    for (key, country) in &countries {
        let Some(country_id) = upsert_country(&state.db, key, country).await? else {
            continue;
        };
        report.countries += 1;

        tokio::time::sleep(REQUEST_SPACING).await;

        let url = format!("{GUEST_PRODUCTS}/{key}/any");
        let listing: HashMap<String, GuestProduct> = match http.get(&url).send().await {
            Ok(response) if response.status().is_success() => match response.json().await {
                Ok(listing) => listing,
                Err(err) => {
                    tracing::warn!(country = %key, error = %err, "5sim listing unreadable");
                    continue;
                }
            },
            Ok(response) => {
                tracing::warn!(country = %key, status = %response.status(), "5sim listing refused");
                continue;
            }
            Err(err) => {
                tracing::warn!(country = %key, error = %err, "5sim listing unreachable");
                continue;
            }
        };

        let offers: Vec<(&String, &GuestProduct)> = listing
            .iter()
            .filter(|(_, offer)| offer.category == ACTIVATION)
            .collect();
        if offers.is_empty() {
            continue;
        }

        let product_ids = upsert_products(state, &offers).await?;
        report.products = report.products.max(product_ids.len());

        let written = upsert_prices(state, country_id, &offers, &product_ids, pricing).await?;
        report.rows += written;
        report.in_stock += offers.iter().filter(|(_, o)| o.qty > 0).count();

        if let Some(iso) = country.iso.keys().next() {
            let iso = iso.to_uppercase();
            for (product_key, product) in &offers {
                let success = product
                    .rate
                    .as_ref()
                    .or(product.success.as_ref())
                    .and_then(number_offers::parse_success_json);
                let Some(success_rate) = success else {
                    continue;
                };
                if product.qty <= 0 {
                    continue;
                }
                fivesim_skus.push(OfferSku {
                    provider: "fivesim",
                    product_slug: (*product_key).clone(),
                    country_code: iso.clone(),
                    provider_product: (*product_key).clone(),
                    provider_country: key.clone(),
                    provider_operator: None,
                    cost: product.price,
                    currency: pricing
                        .supplier_currency
                        .clone()
                        .unwrap_or_else(|| "USD".into()),
                    success_rate,
                    stock: i32::try_from(product.qty.max(0)).unwrap_or(i32::MAX),
                });
            }
        }
    }

    if report.countries == 0 {
        anyhow::bail!("no country could be read from 5sim");
    }

    Ok((report, fivesim_skus))
}

/// `fivesim_skus` is `Some` only after a successful guest catalogue sweep.
/// On success, missing fivesim sources are zeroed (including an empty list).
/// On failure (`None`), last fivesim rows stay until the next good sweep.
async fn sync_offers(
    state: &AppState,
    pricing: &Pricing,
    offers: &OfferSync,
    fivesim_skus: Option<Vec<OfferSku>>,
) -> anyhow::Result<()> {
    if offers.write_stub {
        number_offers::apply_provider_skus(
            &state.db,
            pricing,
            "stub",
            &number_offers::stub_skus(),
            true,
        )
        .await?;
    } else {
        // Live keys are on: stub fixtures must not stay on the public list.
        number_offers::apply_provider_skus(&state.db, pricing, "stub", &[], true).await?;
    }
    if let Some(skus) = fivesim_skus {
        number_offers::apply_provider_skus(&state.db, pricing, "fivesim", &skus, true).await?;
    }
    if let Some(pool) = &offers.smspool {
        match pool.fetch_skus().await {
            Ok(skus) => {
                number_offers::apply_provider_skus(
                    &state.db,
                    &offers.smspool_pricing,
                    "smspool",
                    &skus,
                    true,
                )
                .await?;
            }
            Err(err) => tracing::warn!(error = ?err, "smspool offer sweep failed, keeping last rows"),
        }
    }
    Ok(())
}

/// Insert a country the supplier lists, or return the id of the one we have.
///
/// `iso` and `prefix` are keyed by their own value, so a missing key means the
/// supplier gave us a country we cannot address — skipped rather than guessed.
///
/// Naivolt identity is ISO `code`. Two 5SIM guest keys that share one ISO must
/// reuse one row; upserting only on `provider_country` used to abort the sweep
/// on `number_countries_code_key`.
async fn upsert_country(
    db: &sqlx::PgPool,
    key: &str,
    country: &GuestCountry,
) -> anyhow::Result<Option<Uuid>> {
    let (Some(iso), Some(prefix)) = (
        country.iso.keys().next().cloned(),
        country.prefix.keys().next().cloned(),
    ) else {
        return Ok(None);
    };

    let code = iso.to_uppercase();
    let name = country
        .text_en
        .clone()
        .unwrap_or_else(|| humanise(key));

    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "UPDATE number_countries
            SET name = $2, dial_code = $3
          WHERE provider_country = $1
      RETURNING id",
    )
    .bind(key)
    .bind(&name)
    .bind(&prefix)
    .fetch_optional(db)
    .await?
    {
        return Ok(Some(id));
    }

    // Same ISO, different supplier key: keep the existing provider_country so
    // buy paths that still read the country row stay stable.
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "UPDATE number_countries
            SET name = $2, dial_code = $3
          WHERE code = $1
      RETURNING id",
    )
    .bind(&code)
    .bind(&name)
    .bind(&prefix)
    .fetch_optional(db)
    .await?
    {
        return Ok(Some(id));
    }

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO number_countries (code, name, dial_code, provider_country)
         VALUES ($1, $2, $3, $4)
         RETURNING id",
    )
    .bind(&code)
    .bind(&name)
    .bind(&prefix)
    .bind(key)
    .fetch_one(db)
    .await?;

    Ok(Some(id))
}

/// Insert every product in one statement, and return their ids by supplier key.
///
/// One round trip per country rather than one per product: a country can list
/// 779 of them, and 153 countries of per-row inserts is a sweep that never ends.
async fn upsert_products(
    state: &AppState,
    offers: &[(&String, &GuestProduct)],
) -> anyhow::Result<HashMap<String, Uuid>> {
    let keys: Vec<String> = offers.iter().map(|(k, _)| (*k).clone()).collect();
    let names: Vec<String> = keys.iter().map(|k| humanise(k)).collect();

    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "INSERT INTO number_products (slug, name, provider_product)
         SELECT k, n, k FROM UNNEST($1::text[], $2::text[]) AS t(k, n)
         ON CONFLICT (provider_product) DO UPDATE SET name = number_products.name
         RETURNING id, provider_product",
    )
    .bind(&keys)
    .bind(&names)
    .fetch_all(&state.db)
    .await?;

    Ok(rows.into_iter().map(|(id, key)| (key, id)).collect())
}

/// Write a country's prices in one statement.
///
/// The hysteresis lives in the `ON CONFLICT` rather than in a read-then-write,
/// because reading 75,000 stored prices per sweep to decide whether to change
/// them is most of the work of the sweep.
async fn upsert_prices(
    state: &AppState,
    country_id: Uuid,
    offers: &[(&String, &GuestProduct)],
    product_ids: &HashMap<String, Uuid>,
    pricing: &Pricing,
) -> anyhow::Result<usize> {
    let mut ids = Vec::with_capacity(offers.len());
    let mut prices = Vec::with_capacity(offers.len());
    let mut costs = Vec::with_capacity(offers.len());
    let mut stocks = Vec::with_capacity(offers.len());

    for (key, offer) in offers {
        let Some(id) = product_ids.get(*key) else {
            continue;
        };
        ids.push(*id);
        prices.push(pricing.sale_price(offer.price));
        costs.push(offer.price);
        stocks.push(i32::try_from(offer.qty.max(0)).unwrap_or(i32::MAX));
    }

    if ids.is_empty() {
        return Ok(0);
    }

    // Without a usable currency the cost is still worth recording; the price is
    // not something we can compute, so an existing one is kept and a new row is
    // priced at the floor rather than at a guess.
    let priced = pricing.prices_in_usd();
    let currency = pricing
        .supplier_currency
        .clone()
        .unwrap_or_else(|| "USD".to_owned());

    let written = sqlx::query(&format!(
        "INSERT INTO number_prices
            (product_id, country_id, price_ngn, provider_cost, provider_cost_currency,
             provider_operator, stock, synced_at, updated_at, last_in_stock_at)
         SELECT p, $2, price, cost, $6, 'any', stock, now(), now(),
                CASE WHEN stock > 0 THEN now() END
           FROM UNNEST($1::uuid[], $3::numeric[], $4::numeric[], $5::int[])
                AS t(p, price, cost, stock)
         ON CONFLICT (product_id, country_id) DO UPDATE
            SET price_ngn = CASE
                    WHEN NOT {priced} THEN number_prices.price_ngn
                    WHEN abs(EXCLUDED.price_ngn - number_prices.price_ngn)
                         / GREATEST(number_prices.price_ngn, 1) < {PRICE_HYSTERESIS}
                    THEN number_prices.price_ngn
                    ELSE EXCLUDED.price_ngn
                END,
                provider_cost = EXCLUDED.provider_cost,
                provider_cost_currency = EXCLUDED.provider_cost_currency,
                stock = EXCLUDED.stock,
                synced_at = now(),
                updated_at = now(),
                last_in_stock_at = COALESCE(EXCLUDED.last_in_stock_at,
                                            number_prices.last_in_stock_at)"
    ))
    .bind(&ids)
    .bind(country_id)
    .bind(&prices)
    .bind(&costs)
    .bind(&stocks)
    .bind(&currency)
    .execute(&state.db)
    .await?
    .rows_affected();

    Ok(written as usize)
}

/// A supplier key turned into something a person would recognise.
///
/// 5SIM's keys are lowercase and punctuation-free — `whatsapp`, `1688`,
/// `99app`, `applepay`. Title casing gets most of the way; the brands people
/// actually look for are worth spelling the way they spell themselves, because
/// "Whatsapp" in a list of a thousand services reads as a knock-off.
fn humanise(key: &str) -> String {
    const BRANDS: &[(&str, &str)] = &[
        ("whatsapp", "WhatsApp"),
        ("tiktok", "TikTok"),
        ("paypal", "PayPal"),
        ("wechat", "WeChat"),
        ("youtube", "YouTube"),
        ("linkedin", "LinkedIn"),
        ("snapchat", "Snapchat"),
        ("facebook", "Facebook"),
        ("instagram", "Instagram"),
        ("telegram", "Telegram"),
        ("twitter", "X (Twitter)"),
        ("openai", "OpenAI"),
        ("github", "GitHub"),
        ("payoneer", "Payoneer"),
        ("binance", "Binance"),
        ("coinbase", "Coinbase"),
        ("airbnb", "Airbnb"),
        ("aliexpress", "AliExpress"),
        ("ebay", "eBay"),
        ("imo", "IMO"),
        ("kakaotalk", "KakaoTalk"),
        ("viber", "Viber"),
        ("bolt", "Bolt"),
        ("uber", "Uber"),
        ("glovo", "Glovo"),
        ("jumia", "Jumia"),
        ("opay", "OPay"),
        ("kuda", "Kuda"),
    ];

    if let Some((_, brand)) = BRANDS.iter().find(|(k, _)| *k == key) {
        return (*brand).to_owned();
    }

    key.split(|c: char| c == '-' || c == '_' || c == '.')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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
        let pricing = pricing();
        assert_eq!(pricing.sale_price(dec!(0.28)), dec!(690));
        assert_eq!(pricing.sale_price(dec!(0.9)), dec!(2210));
    }

    #[test]
    fn nothing_sells_for_less_than_a_hundred_naira() {
        assert_eq!(pricing().sale_price(dec!(0.001)), dec!(100));
    }

    #[test]
    fn a_supplier_currency_that_is_not_usd_stops_pricing() {
        let rub = Pricing {
            supplier_currency: Some("RUB".into()),
            ..pricing()
        };
        assert!(!rub.prices_in_usd());
        assert!(pricing().prices_in_usd());
    }

    #[test]
    fn brands_keep_their_own_spelling() {
        // In a list of a thousand services, "Whatsapp" reads as a knock-off.
        assert_eq!(humanise("whatsapp"), "WhatsApp");
        assert_eq!(humanise("tiktok"), "TikTok");
        assert_eq!(humanise("twitter"), "X (Twitter)");
    }

    #[test]
    fn anything_else_is_title_cased_rather_than_dropped() {
        // Most of the catalogue is services nobody has heard of, and they still
        // have to render as something.
        assert_eq!(humanise("99app"), "99app");
        assert_eq!(humanise("bolt-food"), "Bolt Food");
        assert_eq!(humanise("yandex_go"), "Yandex Go");
        assert_eq!(humanise("1688"), "1688");
    }

    #[tokio::test]
    async fn upsert_country_reuses_iso_when_provider_keys_differ() {
        use crate::test_database::IsolatedDatabase;

        let database = IsolatedDatabase::new("country_iso_upsert").await;

        let first = GuestCountry {
            iso: HashMap::from([("zz".into(), serde_json::json!(1))]),
            prefix: HashMap::from([("+999".into(), serde_json::json!(1))]),
            text_en: Some("Testland".into()),
        };
        let second = GuestCountry {
            iso: HashMap::from([("zz".into(), serde_json::json!(1))]),
            prefix: HashMap::from([("+999".into(), serde_json::json!(1))]),
            text_en: Some("Testland Alt".into()),
        };

        let id1 = upsert_country(&database.pool, "testland", &first)
            .await
            .unwrap()
            .expect("first insert");
        let id2 = upsert_country(&database.pool, "testland-alt", &second)
            .await
            .unwrap()
            .expect("second insert must reuse ISO");
        assert_eq!(id1, id2);

        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM number_countries WHERE code = 'ZZ'")
                .fetch_one(&database.pool)
                .await
                .unwrap();
        assert_eq!(count, 1);

        let provider: String =
            sqlx::query_scalar("SELECT provider_country FROM number_countries WHERE code = 'ZZ'")
                .fetch_one(&database.pool)
                .await
                .unwrap();
        assert_eq!(provider, "testland");

        database.cleanup().await;
    }

    /// Successful 5SIM catalogue sync must zero fivesim sources that disappeared,
    /// matching SMSPool. A failed sync must leave last rows alone.
    #[tokio::test]
    async fn successful_fivesim_offer_sync_zeros_missing_sources() {
        use crate::config::{Config, Environment};
        use crate::funding_provider::{AnyFundingProvider, StubFunding};
        use crate::google_keys::GoogleKeys;
        use crate::notify::{AnyNotifier, LogNotifier};
        use crate::number_provider::{AnyNumberProvider, StubProvider};
        use crate::payout_provider;
        use crate::pricing::Rates;
        use crate::signer::{AnyAddressProvider, LocalSigner};
        use crate::test_database::IsolatedDatabase;
        use naivolt_auth::session::SessionKeys;
        use std::sync::Arc;

        let database = IsolatedDatabase::new("fivesim_zero_missing").await;
        let pool = database.pool.clone();
        let pricing = pricing();

        let stale = OfferSku {
            provider: "fivesim",
            product_slug: "whatsapp".into(),
            country_code: "NG".into(),
            provider_product: "whatsapp".into(),
            provider_country: "nigeria".into(),
            provider_operator: Some("any".into()),
            cost: dec!(0.28),
            currency: "USD".into(),
            success_rate: Decimal::from(80),
            stock: 9,
        };
        number_offers::apply_provider_skus(&pool, &pricing, "fivesim", &[stale], false)
            .await
            .unwrap();
        let before: i32 = sqlx::query_scalar(
            "SELECT stock FROM number_offer_sources
              WHERE provider = 'fivesim' AND provider_product = 'whatsapp'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(before, 9);

        let config = Config {
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
            smspool_api_key: None,
            smspool_currency: Some("USD".into()),
            smspool_base_url: "https://api.smspool.net".into(),
            google_allowed_emails: Vec::new(),
            admin_token: None,
            web_app_url: "http://localhost".into(),
            numbers_margin: dec!(1.6),
            usd_ngn_mid: dec!(1530),
            spread_ngn_per_usd: dec!(20),
        };
        let state = AppState {
            db: pool.clone(),
            keys: Arc::new(SessionKeys::from_secret(config.jwt_secret.as_bytes()).unwrap()),
            notifier: Arc::new(AnyNotifier::Log(LogNotifier)),
            addresses: Arc::new(AnyAddressProvider::Local(
                LocalSigner::from_mnemonic(
                    crate::signer::tests::TEST_MNEMONIC,
                )
                .unwrap(),
            )),
            rates: Rates::new(&config),
            payouts: Arc::new(payout_provider::AnyPayoutProvider::Stub(
                payout_provider::StubProvider,
            )),
            numbers: Arc::new(AnyNumberProvider::Stub(StubProvider).into()),
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
        let offers = OfferSync {
            write_stub: false,
            smspool: None,
            smspool_pricing: pricing.clone(),
        };

        // Catalogue sync succeeded but no public fivesim SKU remained → zero missing.
        sync_offers(&state, &pricing, &offers, Some(Vec::new()))
            .await
            .unwrap();
        let after_ok: i32 = sqlx::query_scalar(
            "SELECT stock FROM number_offer_sources
              WHERE provider = 'fivesim' AND provider_product = 'whatsapp'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after_ok, 0, "successful empty fivesim sweep must zero stale stock");

        // Put stock back, then a failed catalogue sync must not wipe it.
        number_offers::apply_provider_skus(
            &pool,
            &pricing,
            "fivesim",
            &[OfferSku {
                provider: "fivesim",
                product_slug: "whatsapp".into(),
                country_code: "NG".into(),
                provider_product: "whatsapp".into(),
                provider_country: "nigeria".into(),
                provider_operator: Some("any".into()),
                cost: dec!(0.28),
                currency: "USD".into(),
                success_rate: Decimal::from(80),
                stock: 5,
            }],
            false,
        )
        .await
        .unwrap();
        sync_offers(&state, &pricing, &offers, None).await.unwrap();
        let after_fail: i32 = sqlx::query_scalar(
            "SELECT stock FROM number_offer_sources
              WHERE provider = 'fivesim' AND provider_product = 'whatsapp'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after_fail, 5, "failed catalogue sync must keep last fivesim rows");

        database.cleanup().await;
    }
}
