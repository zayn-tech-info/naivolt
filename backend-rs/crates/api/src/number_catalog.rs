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
//!
//! GET /v1/guest/prices
//! {"england":{"whatsapp":{"virtual59":{"cost":0.7,"count":41789,"rate":44.58}}}}
//! ```
//!
//! Guest products feed `number_prices`. Customer offers copy cost, stock, and
//! `rate` from guest prices — 5SIM omits `rate` under 20% or too few orders, and
//! we skip those rows rather than inventing a number.
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
use std::str::FromStr;
use std::time::Duration;
use uuid::Uuid;

const GUEST_COUNTRIES: &str = "https://5sim.net/v1/guest/countries";
const GUEST_PRODUCTS: &str = "https://5sim.net/v1/guest/products";
/// Operator-level cost, stock, and delivery rate. This is the payload behind
/// 5SIM's Prices / Statistics pages. Guest products do not include `rate`.
const GUEST_PRICES: &str = "https://5sim.net/v1/guest/prices";
const FIVESIM_PROFILE: &str = "https://5sim.net/v1/user/profile";

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

/// Shop picker slugs 5SIM names the same way, except X (`twitter`).
const SHOP_GUEST_PRODUCTS: &[&str] = &[
    "whatsapp",
    "telegram",
    "instagram",
    "facebook",
    "tiktok",
    "google",
    "twitter",
    "discord",
    "apple",
    "uber",
    "tinder",
    "amazon",
];

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
    pub fivesim_api_key: Option<String>,
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
            .timeout(Duration::from_secs(60))
            .user_agent("NaivoltNumbers/1.0")
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
                        fivesim_offers = fivesim_skus.as_ref().map(|s| s.len()).unwrap_or(0),
                        "number catalogue synced"
                    );
                    if let Err(err) = sync_offers(&state, &pricing, &offers, fivesim_skus).await
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
) -> anyhow::Result<(SyncReport, Option<Vec<OfferSku>>)> {
    let countries: HashMap<String, GuestCountry> = http
        .get(GUEST_COUNTRIES)
        .send()
        .await?
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("country list unreadable: {e}"))?;

    let mut report = SyncReport::default();

    // Sorted, because two supplier keys can claim one ISO code and only the
    // lower-sorting one keeps it (see `upsert_country`). Iterating the `HashMap`
    // directly still converges, but the loser would spend a sweep writing prices
    // against a row the winner then takes over.
    let mut keys: Vec<&String> = countries.keys().collect();
    keys.sort();

    for key in keys {
        let country = &countries[key];
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
    }

    if report.countries == 0 {
        anyhow::bail!("no country could be read from 5sim");
    }

    // Offers use /guest/prices (cost, count, rate per operator). Guest products
    // do not document Rate; listing from that field produced zero 5SIM offers.
    // Unfiltered JSON is country → product; `?product=` is product → country.
    // Shop slices cover the picker even when the 9MB dump fails or is country-shaped.
    let mut fivesim_skus: Option<Vec<OfferSku>> = None;
    match fetch_guest_prices(http).await {
        Ok(payload) => {
            fivesim_skus = Some(skus_from_guest_prices(&payload, &countries, pricing));
        }
        Err(err) => {
            tracing::warn!(error = ?err, "5sim guest prices unread — trying product slices");
        }
    }
    for product in SHOP_GUEST_PRODUCTS {
        match fetch_guest_prices_for_product(http, product).await {
            Ok(payload) => {
                let extra = skus_from_guest_prices(&payload, &countries, pricing);
                fivesim_skus = Some(merge_skus(fivesim_skus.unwrap_or_default(), extra));
            }
            Err(err) => {
                tracing::warn!(product, error = ?err, "5sim product prices unread");
            }
        }
    }

    Ok((report, fivesim_skus))
}

/// `fivesim_skus` is `Some` only after a successful guest catalogue sweep.
/// On success, missing fivesim sources are zeroed (including an empty list).
/// On failure (`None`), last fivesim rows stay until the next good sweep.
/// SMSPool is never written while sell settings have it off, or its wallet is empty.
async fn sync_offers(
    state: &AppState,
    pricing: &Pricing,
    offers: &OfferSync,
    fivesim_skus: Option<Vec<OfferSku>>,
) -> anyhow::Result<()> {
    let sell = crate::number_sell::load(&state.db)
        .await
        .map_err(|err| anyhow::anyhow!("{err}"))?;

    if offers.write_stub {
        number_offers::apply_provider_skus(
            &state.db,
            pricing,
            "stub",
            &number_offers::stub_skus(),
            true,
        )
        .await?;
        number_offers::apply_provider_skus(&state.db, pricing, "fivesim", &[], true).await?;
        hide_provider(&state.db, &offers.smspool_pricing, "smspool").await?;
        return Ok(());
    }

    number_offers::apply_provider_skus(&state.db, pricing, "stub", &[], true).await?;

    if sell.fivesim_enabled {
        match fivesim_listing(
            http_from_offers(offers),
            offers.fivesim_api_key.as_deref(),
            fivesim_skus,
        )
        .await
        {
            FivesimListing::Write(skus) => {
                number_offers::apply_provider_skus(&state.db, pricing, "fivesim", &skus, true)
                    .await?;
            }
            FivesimListing::KeepLast => {}
        }
    } else {
        hide_provider(&state.db, pricing, "fivesim").await?;
    }

    if sell.smspool_enabled {
        if let Some(pool) = &offers.smspool {
            match smspool_listing(pool).await {
                Ok(Some(skus)) => {
                    number_offers::apply_provider_skus(
                        &state.db,
                        &offers.smspool_pricing,
                        "smspool",
                        &skus,
                        true,
                    )
                    .await?;
                }
                Ok(None) => {}
                Err(err) => {
                    tracing::warn!(error = ?err, "smspool offer sweep failed, keeping last rows")
                }
            }
        } else {
            hide_provider(&state.db, &offers.smspool_pricing, "smspool").await?;
        }
    } else {
        hide_provider(&state.db, &offers.smspool_pricing, "smspool").await?;
    }
    Ok(())
}

async fn hide_provider(
    db: &sqlx::PgPool,
    pricing: &Pricing,
    provider: &str,
) -> anyhow::Result<()> {
    number_offers::apply_provider_skus(db, pricing, provider, &[], true).await?;
    Ok(())
}

enum FivesimListing {
    Write(Vec<OfferSku>),
    KeepLast,
}

fn http_from_offers(_offers: &OfferSync) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("NaivoltNumbers/1.0")
        .build()
        .unwrap_or_default()
}

async fn fivesim_listing(
    http: reqwest::Client,
    api_key: Option<&str>,
    skus: Option<Vec<OfferSku>>,
) -> FivesimListing {
    let balance = match api_key {
        Some(key) => match fetch_fivesim_balance(&http, key).await {
            Ok(balance) => Some(balance),
            Err(err) => {
                tracing::warn!(error = ?err, "5sim profile unread — not guessing float");
                None
            }
        },
        None => None,
    };
    if let Some(balance) = balance {
        if !wallet_is_funded(balance) {
            tracing::warn!("5sim balance is empty — hiding 5SIM from the shop");
            return FivesimListing::Write(Vec::new());
        }
        return match skus {
            Some(skus) => FivesimListing::Write(affordable_skus(skus, balance)),
            None => FivesimListing::KeepLast,
        };
    }
    match skus {
        Some(skus) => FivesimListing::Write(skus),
        None => FivesimListing::KeepLast,
    }
}

async fn smspool_listing(pool: &SmsPoolProvider) -> anyhow::Result<Option<Vec<OfferSku>>> {
    match pool.fetch_balance().await {
        Ok(balance) if !wallet_is_funded(balance) => {
            tracing::warn!("smspool balance is empty — hiding SMSPool from the shop");
            return Ok(Some(Vec::new()));
        }
        Ok(balance) => {
            let skus = pool.fetch_skus().await?;
            Ok(Some(affordable_skus(skus, balance)))
        }
        Err(err) => {
            tracing::warn!(error = ?err, "smspool balance unread — keeping last rows");
            Ok(None)
        }
    }
}

fn affordable_skus(skus: Vec<OfferSku>, max_cost: Decimal) -> Vec<OfferSku> {
    skus.into_iter()
        .filter(|sku| sku.cost <= max_cost && sku.success_rate > Decimal::ZERO)
        .collect()
}

fn wallet_is_funded(balance: Decimal) -> bool {
    balance > Decimal::ZERO
}

async fn fetch_guest_prices(http: &reqwest::Client) -> anyhow::Result<serde_json::Value> {
    fetch_guest_prices_url(http, GUEST_PRICES).await
}

async fn fetch_guest_prices_for_product(
    http: &reqwest::Client,
    product: &str,
) -> anyhow::Result<serde_json::Value> {
    let url = format!("{GUEST_PRICES}?product={product}");
    fetch_guest_prices_url(http, &url).await
}

async fn fetch_guest_prices_url(
    http: &reqwest::Client,
    url: &str,
) -> anyhow::Result<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent("NaivoltNumbers/1.0")
        .build()
        .unwrap_or_else(|_| http.clone());
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("5sim guest prices refused {}", response.status());
    }
    Ok(response.json().await?)
}

fn merge_skus(mut left: Vec<OfferSku>, right: Vec<OfferSku>) -> Vec<OfferSku> {
    for sku in right {
        let dup = left.iter().any(|existing| {
            existing.provider == sku.provider
                && existing.provider_product == sku.provider_product
                && existing.provider_country == sku.provider_country
                && existing.provider_operator == sku.provider_operator
        });
        if !dup {
            left.push(sku);
        }
    }
    left
}

async fn fetch_fivesim_balance(http: &reqwest::Client, api_key: &str) -> anyhow::Result<Decimal> {
    let response = http
        .get(FIVESIM_PROFILE)
        .bearer_auth(api_key)
        .header("Accept", "application/json")
        .send()
        .await?;
    if !response.status().is_success() {
        anyhow::bail!("5sim profile refused {}", response.status());
    }
    let body: serde_json::Value = response.json().await?;
    json_decimal(body.get("balance")).ok_or_else(|| anyhow::anyhow!("5sim profile had no balance"))
}

fn json_decimal(value: Option<&serde_json::Value>) -> Option<Decimal> {
    let value = value?;
    match value {
        serde_json::Value::Number(n) => n
            .as_f64()
            .and_then(|f| Decimal::from_str(&f.to_string()).ok())
            .or_else(|| n.as_i64().map(Decimal::from)),
        serde_json::Value::String(s) => Decimal::from_str(s.trim()).ok(),
        _ => None,
    }
}

fn json_i64(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    match value {
        serde_json::Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Operator rows from `/v1/guest/prices`.
///
/// Unfiltered dump is `{country: {product: {operator: row}}}`. `?product=` is
/// `{product: {country: {operator: row}}}`. `rate` is omitted or 0 when 5SIM
/// will not publish a figure; `rate1` is the 1-hour statistic. Never invent.
/// `rate72` alone is not a shop statistic — skip the row.
fn skus_from_guest_prices(
    prices: &serde_json::Value,
    countries: &HashMap<String, GuestCountry>,
    pricing: &Pricing,
) -> Vec<OfferSku> {
    let Some(root) = prices.as_object() else {
        return Vec::new();
    };
    let currency = pricing
        .supplier_currency
        .clone()
        .unwrap_or_else(|| "USD".into());
    let mut skus = Vec::new();
    for (top_key, nested) in root {
        if countries.contains_key(top_key) {
            let Some(products) = nested.as_object() else {
                continue;
            };
            for (product_key, operators) in products {
                push_operator_skus(
                    &mut skus,
                    countries,
                    &currency,
                    top_key,
                    product_key,
                    operators,
                );
            }
        } else {
            let Some(by_country) = nested.as_object() else {
                continue;
            };
            for (country_key, operators) in by_country {
                push_operator_skus(
                    &mut skus,
                    countries,
                    &currency,
                    country_key,
                    top_key,
                    operators,
                );
            }
        }
    }
    skus
}

/// 5SIM Statistics "Rate (%)" with Period unset is the `rate` field (then `rate1`).
/// `rate24` / `rate72` are other windows; using them when `rate` is 0 would invent
/// a figure the default Prices tab does not show.
fn row_success_rate(row: &serde_json::Value) -> Option<Decimal> {
    row.get("rate")
        .and_then(number_offers::parse_success_json)
        .or_else(|| row.get("rate1").and_then(number_offers::parse_success_json))
}

fn push_operator_skus(
    skus: &mut Vec<OfferSku>,
    countries: &HashMap<String, GuestCountry>,
    currency: &str,
    country_key: &str,
    product_key: &str,
    operators: &serde_json::Value,
) {
    let Some(country) = countries.get(country_key) else {
        return;
    };
    let Some(iso) = country.iso.keys().next() else {
        return;
    };
    let iso = iso.to_uppercase();
    let Some(operators) = operators.as_object() else {
        return;
    };
    let mut rows: Vec<(&String, i64, Decimal, Decimal)> = Vec::new();
    for (operator, row) in operators {
        let Some(count) = json_i64(row.get("count")) else {
            continue;
        };
        if count <= 0 {
            continue;
        }
        let Some(cost) = json_decimal(row.get("cost")) else {
            continue;
        };
        let Some(success_rate) = row_success_rate(row) else {
            continue;
        };
        rows.push((operator, count, cost, success_rate));
    }
    let has_named = rows.iter().any(|(op, _, _, _)| *op != "any");
    for (operator, count, cost, success_rate) in rows {
        if has_named && operator == "any" {
            continue;
        }
        skus.push(OfferSku {
            provider: "fivesim",
            product_slug: product_key.to_string(),
            country_code: iso.clone(),
            provider_product: product_key.to_string(),
            provider_country: country_key.to_string(),
            provider_operator: Some(operator.clone()),
            cost,
            currency: currency.to_string(),
            success_rate,
            stock: i32::try_from(count).unwrap_or(i32::MAX),
        });
    }
}

/// Insert a country the supplier lists, or return the id of the one we have.
///
/// `iso` and `prefix` are keyed by their own value, so a missing key means the
/// supplier gave us a country we cannot address — skipped rather than guessed.
///
/// ## Two supplier keys, one ISO code
///
/// Naivolt identity is ISO `code`, and `number_countries` keeps it unique. 5SIM
/// ships 153 country keys carrying 152 distinct codes, because it files **French
/// Guiana under `fr`** — France's code, not its own `gf`. Upserting on
/// `provider_country` alone used to abort the whole sweep on
/// `number_countries_code_key` when the second of the two arrived.
///
/// Reusing the row is only half an answer, though. The row's `provider_country`
/// is the single key every order for that code is placed against
/// (`number_routes.rs` resolves a country by `code`, then buys with the
/// `provider_country` it finds), so updating the name and dial code of a row
/// bought against somebody else's key produces a country that advertises French
/// Guiana at +594 and hands out French numbers at +33.
///
/// So the code belongs to exactly one supplier key, and the other is skipped —
/// the same answer as a country with no ISO at all: not one we can address. Its
/// prices are never written, because it never gets an id back to write them
/// against.
///
/// **Lowest key wins, rather than whoever arrived first.** First-writer-wins
/// looks equivalent and is not: this sync had already run before the rule
/// existed, and `frenchguiana` held `FR` — so France, a country people actually
/// buy numbers in, was the one being skipped, permanently, with no amount of
/// re-running able to move it. A tie-break that cannot correct itself needs a
/// human to hand-edit the table, which is the same as not having one. Sorting
/// converges on the same catalogue from any starting state, and the row is taken
/// over in place rather than replaced: its id is what existing orders point at.
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

    // Nobody is selling under our key. Whoever holds the code decides whether we
    // get to, and a row we do not win is one we must not describe.
    let holder: Option<String> =
        sqlx::query_scalar("SELECT provider_country FROM number_countries WHERE code = $1")
            .bind(&code)
            .fetch_optional(db)
            .await?;

    if let Some(holder) = holder {
        if holder.as_str() < key {
            tracing::debug!(
                country = %key, %code, %holder,
                "supplier key skipped: a lower-sorting key already sells under this ISO code"
            );
            return Ok(None);
        }

        let id: Uuid = sqlx::query_scalar(
            "UPDATE number_countries
                SET provider_country = $1, name = $2, dial_code = $3
              WHERE code = $4
          RETURNING id",
        )
        .bind(key)
        .bind(&name)
        .bind(&prefix)
        .bind(&code)
        .fetch_one(db)
        .await?;

        tracing::info!(
            country = %key, %code, replaced = %holder,
            "supplier key took over an ISO code held by a higher-sorting key"
        );

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
    fn guest_prices_copy_rate_skip_missing_and_drop_any_when_named() {
        let pricing = pricing();
        let countries = HashMap::from([(
            "england".into(),
            GuestCountry {
                iso: HashMap::from([("gb".into(), serde_json::json!(1))]),
                prefix: HashMap::from([("+44".into(), serde_json::json!(1))]),
                text_en: Some("England".into()),
            },
        )]);
        let payload = serde_json::json!({
            "england": {
                "whatsapp": {
                    "virtual59": { "cost": 0.7, "count": 41789, "rate": 44.58 },
                    "virtual60": { "cost": 0.9, "count": 41902, "rate": 35 },
                    "any": { "cost": 0.3, "count": 3967222 }
                }
            },
            "laos": {
                "whatsapp": {
                    "virtual1": { "cost": 0.5, "count": 10 }
                }
            }
        });
        let skus = skus_from_guest_prices(&payload, &countries, &pricing);
        assert_eq!(skus.len(), 2, "laos has no rate; any is dropped");
        let product_first = serde_json::json!({
            "whatsapp": {
                "england": {
                    "virtual59": { "cost": 0.7, "count": 41789, "rate": 0, "rate1": 44.58 },
                    "any": { "cost": 0.3, "count": 10, "rate": 90 }
                }
            }
        });
        let from_product = skus_from_guest_prices(&product_first, &countries, &pricing);
        assert_eq!(from_product.len(), 1, "product-first uses rate1; any dropped");
        assert_eq!(
            from_product[0].provider_operator.as_deref(),
            Some("virtual59")
        );
        assert_eq!(from_product[0].success_rate, dec!(44.58));
        assert!(skus.iter().all(|s| s.provider_country == "england"));
        assert!(skus.iter().any(|s| {
            s.provider_operator.as_deref() == Some("virtual59")
                && s.success_rate == dec!(44.58)
                && s.stock == 41789
        }));
        let cheap_only = affordable_skus(skus, dec!(0.8));
        assert_eq!(cheap_only.len(), 1);
        assert_eq!(cheap_only[0].provider_operator.as_deref(), Some("virtual59"));
        let product_first = serde_json::json!({
            "whatsapp": {
                "england": {
                    "virtual59": { "cost": 0.7, "count": 41789, "rate": 0, "rate1": 44.58 },
                    "any": { "cost": 0.3, "count": 10, "rate": 90 }
                }
            }
        });
        let from_product = skus_from_guest_prices(&product_first, &countries, &pricing);
        assert_eq!(from_product.len(), 1, "product-first uses rate1; any dropped");
        assert_eq!(from_product[0].success_rate, dec!(44.58));
        let no_stats = serde_json::json!({
            "england": {
                "whatsapp": {
                    "virtual34": { "cost": 0.3, "count": 4145642, "rate": 0, "rate1": 0, "rate72": 0.26 }
                }
            }
        });
        assert!(
            skus_from_guest_prices(&no_stats, &countries, &pricing).is_empty(),
            "rate72 is not a shop statistic"
        );
        assert!(!wallet_is_funded(dec!(0)));
        assert!(!wallet_is_funded(dec!(-0.01)));
        assert!(wallet_is_funded(dec!(0.05)));
    }

    #[test]
    fn guest_prices_keep_sub_one_rate_as_published_percent() {
        let pricing = pricing();
        let countries = HashMap::from([
            (
                "usa".into(),
                GuestCountry {
                    iso: HashMap::from([("us".into(), serde_json::json!(1))]),
                    prefix: HashMap::from([("+1".into(), serde_json::json!(1))]),
                    text_en: Some("USA".into()),
                },
            ),
            (
                "philippines".into(),
                GuestCountry {
                    iso: HashMap::from([("ph".into(), serde_json::json!(1))]),
                    prefix: HashMap::from([("+63".into(), serde_json::json!(1))]),
                    text_en: Some("Philippines".into()),
                },
            ),
        ]);
        let payload = serde_json::json!({
            "instagram": {
                "philippines": {
                    "virtual34": { "cost": 0.06, "count": 235926, "rate": 0.93, "rate1": 0.93 }
                },
                "usa": {
                    "virtual28": { "cost": 0.3, "count": 25259, "rate": 72.32, "rate1": 72.32 }
                }
            }
        });
        let mut skus = skus_from_guest_prices(&payload, &countries, &pricing);
        skus.sort_by(|a, b| b.success_rate.cmp(&a.success_rate));
        assert_eq!(skus.len(), 2);
        assert_eq!(skus[0].country_code, "US");
        assert_eq!(skus[0].success_rate, dec!(72.32));
        assert_eq!(skus[1].country_code, "PH");
        assert_eq!(skus[1].success_rate, dec!(0.93));
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

    /// 5SIM's real collision: `france` and `frenchguiana` both report iso `fr`.
    fn colliding_pair() -> (GuestCountry, GuestCountry) {
        (
            GuestCountry {
                iso: HashMap::from([("fr".into(), serde_json::json!(1))]),
                prefix: HashMap::from([("+33".into(), serde_json::json!(1))]),
                text_en: Some("France".into()),
            },
            GuestCountry {
                iso: HashMap::from([("fr".into(), serde_json::json!(1))]),
                prefix: HashMap::from([("+594".into(), serde_json::json!(1))]),
                text_en: Some("French Guiana".into()),
            },
        )
    }

    async fn country_row(pool: &sqlx::PgPool, code: &str) -> (String, String, String) {
        sqlx::query_as("SELECT name, dial_code, provider_country FROM number_countries WHERE code = $1")
            .bind(code)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// The row is bought against its `provider_country`, so a name and dial code
    /// belonging to the *other* supplier key would sell French numbers at +33 to
    /// somebody who asked for French Guiana at +594.
    #[tokio::test]
    async fn one_iso_code_belongs_to_one_supplier_key() {
        use crate::test_database::IsolatedDatabase;

        let database = IsolatedDatabase::new("country_iso_owner").await;
        let (france, french_guiana) = colliding_pair();

        let id = upsert_country(&database.pool, "france", &france)
            .await
            .unwrap()
            .expect("first insert");
        assert!(
            upsert_country(&database.pool, "frenchguiana", &french_guiana)
                .await
                .unwrap()
                .is_none(),
            "the higher-sorting key must be skipped, not given the row to price against"
        );

        assert_eq!(
            country_row(&database.pool, "FR").await,
            ("France".into(), "+33".into(), "france".into())
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM number_countries WHERE code = 'FR'")
            .fetch_one(&database.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            upsert_country(&database.pool, "france", &france).await.unwrap(),
            Some(id),
            "the winner keeps its id, and with it every order already placed"
        );

        database.cleanup().await;
    }

    /// The sync had already run before the rule existed, leaving `frenchguiana`
    /// holding `FR`. A first-writer-wins tie-break would strand France there for
    /// good; lowest-key-wins takes the row over in place, keeping its id.
    #[tokio::test]
    async fn a_wrongly_held_iso_code_is_taken_back_without_losing_the_row() {
        use crate::test_database::IsolatedDatabase;

        let database = IsolatedDatabase::new("country_iso_takeover").await;
        let (france, french_guiana) = colliding_pair();

        let squatted = upsert_country(&database.pool, "frenchguiana", &french_guiana)
            .await
            .unwrap()
            .expect("first insert");
        assert_eq!(
            country_row(&database.pool, "FR").await,
            ("French Guiana".into(), "+594".into(), "frenchguiana".into())
        );

        let taken = upsert_country(&database.pool, "france", &france)
            .await
            .unwrap()
            .expect("france must take the code back");

        assert_eq!(taken, squatted, "taking over must not orphan existing orders");
        assert_eq!(
            country_row(&database.pool, "FR").await,
            ("France".into(), "+33".into(), "france".into())
        );
        assert!(
            upsert_country(&database.pool, "frenchguiana", &french_guiana)
                .await
                .unwrap()
                .is_none(),
            "and the loser stays skipped on the next sweep"
        );

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
            cors_allowed_origins: vec!["http://localhost:5173".into()],
            trusted_proxy_loopback: false,
            rate_limits: crate::config::RateLimitQuotas::defaults(),
            operator_totp_key: None,
            admin_refund_cap_ngn: rust_decimal::Decimal::from(100_000),
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
            operator_totp_key: None,
            admin_refund_cap_ngn: rust_decimal::Decimal::from(100_000),
            totp_lockouts: std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            web_app_url: "http://localhost".into(),
        };
        let offers = OfferSync {
            write_stub: false,
            fivesim_api_key: None,
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

    #[tokio::test]
    async fn hiding_smspool_zeros_stock_left_on_the_shop() {
        use crate::test_database::IsolatedDatabase;
        let database = IsolatedDatabase::new("hide_smspool_stock").await;
        let pool = database.pool.clone();
        let pricing = pricing();
        let leftover = OfferSku {
            provider: "smspool",
            product_slug: "whatsapp".into(),
            country_code: "NG".into(),
            provider_product: "907".into(),
            provider_country: "NG".into(),
            provider_operator: None,
            cost: dec!(0.22),
            currency: "USD".into(),
            success_rate: Decimal::from(65),
            stock: 17_937_247,
        };
        number_offers::apply_provider_skus(&pool, &pricing, "smspool", &[leftover], true)
            .await
            .unwrap();
        let before: i32 = sqlx::query_scalar(
            "SELECT stock FROM number_offer_sources WHERE provider = 'smspool'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(before, 17_937_247);
        hide_provider(&pool, &pricing, "smspool").await.unwrap();
        let after: i32 = sqlx::query_scalar(
            "SELECT stock FROM number_offer_sources WHERE provider = 'smspool'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0);
        database.cleanup().await;
    }
}
