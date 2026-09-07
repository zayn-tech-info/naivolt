//! Persist Naivolt offers from provider SKUs. Request handlers read Postgres only.

use crate::number_catalog::Pricing;
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::str::FromStr;
use uuid::Uuid;

pub struct OfferSku {
    pub provider: &'static str,
    pub product_slug: String,
    pub country_code: String,
    pub provider_product: String,
    pub provider_country: String,
    pub provider_operator: Option<String>,
    pub cost: Decimal,
    pub currency: String,
    pub success_rate: Decimal,
    pub stock: i32,
}

pub fn parse_success_rate(value: Decimal) -> Option<Decimal> {
    if value == Decimal::ONE || value == Decimal::from(100) {
        return Some(Decimal::from(100));
    }
    if value > Decimal::ONE && value <= Decimal::from(99) {
        return Some(value);
    }
    if value > Decimal::ZERO && value < Decimal::ONE {
        return Some(value * Decimal::from(100));
    }
    None
}

pub fn parse_success_json(value: &serde_json::Value) -> Option<Decimal> {
    let raw = match value {
        serde_json::Value::Number(n) => n
            .as_f64()
            .and_then(|f| Decimal::from_str(&f.to_string()).ok())
            .or_else(|| n.as_i64().map(Decimal::from)),
        serde_json::Value::String(s) => Decimal::from_str(s.trim()).ok(),
        _ => None,
    }?;
    parse_success_rate(raw)
}

pub fn stub_skus() -> Vec<OfferSku> {
    vec![
        OfferSku {
            provider: "stub",
            product_slug: "whatsapp".into(),
            country_code: "NG".into(),
            provider_product: "whatsapp".into(),
            provider_country: "nigeria".into(),
            provider_operator: None,
            cost: Decimal::new(20, 2),
            currency: "USD".into(),
            success_rate: Decimal::from(82),
            stock: 12,
        },
        OfferSku {
            provider: "stub",
            product_slug: "whatsapp".into(),
            country_code: "NG".into(),
            provider_product: "whatsapp-low".into(),
            provider_country: "nigeria".into(),
            provider_operator: Some("budget".into()),
            cost: Decimal::new(8, 2),
            currency: "USD".into(),
            success_rate: Decimal::from(39),
            stock: 4,
        },
    ]
}

/// Write SKUs for one provider. On success, unseen SKUs for that provider go to stock 0.
pub async fn apply_provider_skus(
    db: &PgPool,
    pricing: &Pricing,
    provider: &str,
    skus: &[OfferSku],
    zero_missing: bool,
) -> anyhow::Result<usize> {
    if !pricing.prices_in_usd() && provider != "stub" {
        tracing::warn!(%provider, "offer costs not USD, skipping naira rewrite for this sweep");
    }
    let mut written = 0usize;
    let mut seen_product = Vec::new();
    let mut seen_country = Vec::new();
    let mut seen_operator = Vec::new();

    for sku in skus {
        if sku.provider != provider {
            continue;
        }
        let Some(product_id) = product_id(db, &sku.product_slug).await? else {
            continue;
        };
        let Some(country_id) = country_id(db, &sku.country_code).await? else {
            continue;
        };
        let price_ngn = if pricing.prices_in_usd() || provider == "stub" {
            pricing.sale_price(sku.cost)
        } else {
            continue;
        };
        let offer_id: Uuid = sqlx::query_scalar(
            "INSERT INTO number_offers
                (product_id, country_id, price_ngn, success_rate, success_fetched_at, quantity, active, synced_at)
             VALUES ($1, $2, $3, $4, now(), $5, $6, now())
             ON CONFLICT (product_id, country_id, price_ngn, success_rate) DO UPDATE
                SET success_fetched_at = now(), synced_at = now()
             RETURNING id",
        )
        .bind(product_id)
        .bind(country_id)
        .bind(price_ngn)
        .bind(sku.success_rate)
        .bind(sku.stock.max(0))
        .bind(sku.stock > 0)
        .fetch_one(db)
        .await?;

        sqlx::query(
            "INSERT INTO number_offer_sources
                (offer_id, provider, provider_product, provider_country, provider_operator,
                 provider_cost, provider_cost_currency, provider_success_rate, stock, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
             ON CONFLICT (provider, provider_product, provider_country, provider_operator)
             DO UPDATE SET
                offer_id = EXCLUDED.offer_id,
                provider_cost = EXCLUDED.provider_cost,
                provider_cost_currency = EXCLUDED.provider_cost_currency,
                provider_success_rate = EXCLUDED.provider_success_rate,
                stock = EXCLUDED.stock,
                synced_at = now()",
        )
        .bind(offer_id)
        .bind(provider)
        .bind(&sku.provider_product)
        .bind(&sku.provider_country)
        .bind(
            sku.provider_operator
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(""),
        )
        .bind(sku.cost)
        .bind(&sku.currency)
        .bind(sku.success_rate)
        .bind(sku.stock.max(0))
        .execute(db)
        .await?;

        seen_product.push(sku.provider_product.clone());
        seen_country.push(sku.provider_country.clone());
        seen_operator.push(sku.provider_operator.clone().unwrap_or_default());
        written += 1;
    }

    if zero_missing && !seen_product.is_empty() {
        sqlx::query(
            "UPDATE number_offer_sources s SET stock = 0, synced_at = now()
              WHERE s.provider = $1
                AND NOT EXISTS (
                    SELECT 1 FROM UNNEST($2::text[], $3::text[], $4::text[]) AS t(p, c, o)
                     WHERE t.p = s.provider_product
                       AND t.c = s.provider_country
                       AND t.o = s.provider_operator
                )",
        )
        .bind(provider)
        .bind(&seen_product)
        .bind(&seen_country)
        .bind(&seen_operator)
        .execute(db)
        .await?;
    }

    sqlx::query(
        "UPDATE number_offers o SET
            quantity = COALESCE((SELECT SUM(s.stock) FROM number_offer_sources s WHERE s.offer_id = o.id), 0),
            active = COALESCE((SELECT SUM(s.stock) FROM number_offer_sources s WHERE s.offer_id = o.id), 0) > 0,
            synced_at = now()",
    )
    .execute(db)
    .await?;

    Ok(written)
}

async fn product_id(db: &PgPool, slug: &str) -> anyhow::Result<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM number_products WHERE active AND (slug = $1 OR provider_product = $1) LIMIT 1",
    )
    .bind(slug)
    .fetch_optional(db)
    .await?)
}

async fn country_id(db: &PgPool, code: &str) -> anyhow::Result<Option<Uuid>> {
    Ok(
        sqlx::query_scalar("SELECT id FROM number_countries WHERE code = $1 AND active")
            .bind(code.to_uppercase())
            .fetch_optional(db)
            .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn smspool_one_and_one_hundred_are_full_success() {
        assert_eq!(parse_success_rate(dec!(1)), Some(dec!(100)));
        assert_eq!(parse_success_rate(dec!(100)), Some(dec!(100)));
        assert_eq!(parse_success_rate(dec!(39)), Some(dec!(39)));
        assert_eq!(parse_success_rate(dec!(0.82)), Some(dec!(82)));
        assert_eq!(parse_success_rate(dec!(0)), None);
        assert_eq!(parse_success_rate(dec!(150)), None);
    }
}
