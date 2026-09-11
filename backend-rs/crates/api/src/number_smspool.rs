//! SMSPool HTTP adapter. Customer JSON never names this supplier.

use crate::error::{ApiError, ApiResult};
use crate::number_offers::OfferSku;
use crate::number_provider::{
    Activation, ActivationCheck, ActivationLifecycle, PurchaseError, Sms, COPY_BUY_RESTORED,
    COPY_OUT_OF_STOCK, COPY_SOURCE_UNAVAILABLE,
};
use chrono::Utc;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;

const DEFAULT_BASE: &str = "https://api.smspool.net";
const REQUEST_SPACING: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub struct SmsPoolProvider {
    http: reqwest::Client,
    api_key: String,
    base: String,
    currency: String,
}

impl SmsPoolProvider {
    pub fn new(api_key: String, currency: Option<String>, base: Option<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            api_key,
            base: base
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| DEFAULT_BASE.to_owned()),
            currency: currency
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "USD".to_owned()),
        }
    }

    pub fn currency(&self) -> &str {
        &self.currency
    }

    /// Build offer SKUs from the live catalogue.
    ///
    /// SMSPool's success endpoint requires a `service` parameter and returns
    /// per-country `short_name`, `price`, `stock`, and `success_rate` in one
    /// payload. Stock is read from that response; `/sms/stock` alone refuses
    /// without a country.
    pub async fn fetch_skus(&self) -> anyhow::Result<Vec<OfferSku>> {
        let services = self.fetch_mapped_services().await?;
        if services.is_empty() {
            anyhow::bail!("smspool service list had no mapped platforms");
        }

        let mut skus = Vec::new();
        for (index, service) in services.iter().enumerate() {
            if index > 0 {
                tokio::time::sleep(REQUEST_SPACING).await;
            }
            let rows = self.fetch_success_rows(&service.provider_id).await?;
            skus.extend(skus_from_success_rows(
                &service.slug,
                &service.provider_id,
                &rows,
                &self.currency,
            ));
        }
        Ok(skus)
    }

    /// Wallet float. Zero means we cannot buy, so the shop must not list us.
    pub async fn fetch_balance(&self) -> anyhow::Result<Decimal> {
        let url = format!("{}/request/balance", self.base.trim_end_matches('/'));
        let response = self
            .http
            .post(&url)
            .form(&[("key", self.api_key.as_str())])
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!("smspool balance refused {}", response.status());
        }
        let body: Value = response.json().await?;
        parse_balance_json(&body)
    }

    async fn fetch_mapped_services(&self) -> anyhow::Result<Vec<MappedService>> {
        let url = format!("{}/service/retrieve_all", self.base.trim_end_matches('/'));
        let response = self
            .http
            .post(&url)
            .form(&[("key", self.api_key.as_str())])
            .send()
            .await?;
        if !response.status().is_success() {
            tracing::warn!(status = %response.status(), "smspool service list refused");
            anyhow::bail!("smspool service list refused");
        }
        let body: Value = response.json().await?;
        let rows = body.as_array().cloned().unwrap_or_default();
        Ok(select_mapped_services(&rows))
    }

    async fn fetch_success_rows(&self, service: &str) -> anyhow::Result<Vec<Value>> {
        let url = format!("{}/request/success_rate", self.base.trim_end_matches('/'));
        let response = self
            .http
            .post(&url)
            .form(&[
                ("key", self.api_key.as_str()),
                ("service", service),
            ])
            .send()
            .await?;
        if !response.status().is_success() {
            tracing::warn!(
                status = %response.status(),
                service,
                "smspool success_rate refused"
            );
            anyhow::bail!("smspool success_rate refused");
        }
        let body: Value = response.json().await?;
        Ok(body
            .as_array()
            .cloned()
            .or_else(|| body.get("data").and_then(Value::as_array).cloned())
            .unwrap_or_default())
    }

    pub async fn buy(
        &self,
        country: &str,
        product: &str,
    ) -> Result<Activation, PurchaseError> {
        let url = format!("{}/purchase/sms", self.base.trim_end_matches('/'));
        let response = self
            .http
            .post(&url)
            .form(&[
                ("key", self.api_key.as_str()),
                ("country", country),
                ("service", product),
            ])
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, "smspool buy failed");
                crate::number_provider::classify_buy_transport(&e)
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(%status, "smspool buy rejected");
            return Err(classify_smspool_failure(status.is_server_error(), &body, None));
        }
        let body: Value = response.json().await.map_err(|e| {
            tracing::warn!(error = %e, "smspool buy returned unreadable body");
            PurchaseError::Ambiguous
        })?;
        if let Some(err) = smspool_error_from_json(&body) {
            return Err(err);
        }
        let order: SmsPoolOrder = serde_json::from_value(body).map_err(|e| {
            tracing::warn!(error = %e, "smspool buy returned unreadable body");
            PurchaseError::Ambiguous
        })?;
        let order_id = order
            .orderid
            .or(order.order_id)
            .filter(|s| !s.is_empty())
            .ok_or(PurchaseError::Ambiguous)?;
        let phone = order.phonenumber.or(order.number).unwrap_or_default();
        if phone.is_empty() {
            return Err(PurchaseError::Ambiguous);
        }
        Ok(Activation {
            provider_order_id: order_id,
            phone,
            cost: order.cost.or(order.price),
            cost_currency: Some(self.currency.clone()),
            expires_at: Some(Utc::now() + chrono::Duration::minutes(20)),
        })
    }

    pub async fn check(&self, order_id: &str) -> ApiResult<ActivationCheck> {
        let url = format!("{}/sms/check", self.base.trim_end_matches('/'));
        let response = self
            .http
            .post(&url)
            .form(&[("key", self.api_key.as_str()), ("orderid", order_id)])
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, %order_id, "smspool check failed");
                ApiError::ServiceUnavailable("We couldn't check that number just now.".into())
            })?;
        if !response.status().is_success() {
            tracing::warn!(status = %response.status(), %order_id, "smspool check rejected");
            return Err(ApiError::ServiceUnavailable(
                "We couldn't check that number just now.".into(),
            ));
        }
        let body: Value = response.json().await.map_err(|_| {
            ApiError::ServiceUnavailable("We couldn't check that number just now.".into())
        })?;
        Ok(parse_smspool_check(&body))
    }

    pub async fn cancel(&self, order_id: &str) -> ApiResult<()> {
        let url = format!("{}/sms/cancel", self.base.trim_end_matches('/'));
        let response = self
            .http
            .post(&url)
            .form(&[("key", self.api_key.as_str()), ("orderid", order_id)])
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, %order_id, "smspool cancel failed");
                ApiError::ServiceUnavailable("We couldn't release that number.".into())
            })?;
        if !response.status().is_success() {
            return Err(ApiError::ServiceUnavailable(
                "That number can't be released just yet. Try again in a moment.".into(),
            ));
        }
        Ok(())
    }
}

fn json_success_zero(value: &Value) -> bool {
    match value.get("success") {
        Some(Value::Bool(false)) => true,
        Some(Value::Number(n)) => n.as_i64() == Some(0) || n.as_f64() == Some(0.0),
        Some(Value::String(s)) => s.trim() == "0" || s.eq_ignore_ascii_case("false"),
        _ => false,
    }
}

fn smspool_error_from_json(body: &Value) -> Option<PurchaseError> {
    let kind = value_key(body.get("type").unwrap_or(&Value::Null)).to_ascii_uppercase();
    let message = value_key(body.get("message").unwrap_or(&Value::Null));
    if !json_success_zero(body) && kind.is_empty() {
        return None;
    }
    Some(classify_smspool_failure(
        false,
        &format!("{kind} {message}"),
        Some(body),
    ))
}

fn classify_smspool_failure(
    server_error: bool,
    body: &str,
    json: Option<&Value>,
) -> PurchaseError {
    let lower = body.to_ascii_lowercase();
    let kind = json
        .and_then(|v| v.get("type"))
        .map(value_key)
        .unwrap_or_default()
        .to_ascii_uppercase();
    if kind == "OUT_OF_STOCK"
        || lower.contains("out_of_stock")
        || lower.contains("out of stock")
        || lower.contains("available")
        || (lower.contains("stock") && !lower.contains("balance"))
    {
        return PurchaseError::Rejected(ApiError::ServiceUnavailable(COPY_OUT_OF_STOCK.into()));
    }
    if kind == "BALANCE_ERROR"
        || lower.contains("balance")
        || lower.contains("funds")
        || lower.contains("no money")
    {
        return PurchaseError::Rejected(ApiError::ServiceUnavailable(
            COPY_SOURCE_UNAVAILABLE.into(),
        ));
    }
    if server_error {
        return PurchaseError::Ambiguous;
    }
    PurchaseError::Rejected(ApiError::ServiceUnavailable(COPY_BUY_RESTORED.into()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MappedService {
    slug: String,
    provider_id: String,
}

#[derive(Deserialize)]
struct SmsPoolOrder {
    #[serde(default)]
    orderid: Option<String>,
    #[serde(default, rename = "order_id")]
    order_id: Option<String>,
    #[serde(default)]
    phonenumber: Option<String>,
    #[serde(default)]
    number: Option<String>,
    #[serde(default)]
    cost: Option<Decimal>,
    #[serde(default)]
    price: Option<Decimal>,
}

fn json_decimal(value: &Value) -> Option<Decimal> {
    match value {
        Value::Number(n) => n
            .as_f64()
            .and_then(|f| Decimal::from_str(&f.to_string()).ok())
            .or_else(|| n.as_i64().map(Decimal::from)),
        Value::String(s) => Decimal::from_str(s.trim()).ok(),
        _ => None,
    }
}

fn value_key(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn map_service(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    const MAP: &[(&str, &str)] = &[
        ("whatsapp", "whatsapp"),
        ("telegram", "telegram"),
        ("instagram", "instagram"),
        ("facebook", "facebook"),
        ("tiktok", "tiktok"),
        ("google", "google"),
        ("twitter", "x"),
        ("x.com", "x"),
        ("discord", "discord"),
        ("apple", "apple"),
        ("uber", "uber"),
        ("tinder", "tinder"),
        ("amazon", "amazon"),
    ];
    MAP.iter()
        .find(|(needle, _)| n.contains(needle))
        .map(|(_, slug)| *slug)
}

fn map_service_score(name: &str, slug: &str) -> u8 {
    let n = name.to_ascii_lowercase();
    let needle = match slug {
        "x" => "twitter",
        other => other,
    };
    if n == needle {
        0
    } else if n.starts_with(needle) {
        1
    } else {
        2
    }
}

/// One SMSPool service id per Naivolt slug. Prefer an exact or prefix name match
/// so "Google/Gmail" wins over "Google Voice" / "Google Play". Equal scores break
/// ties toward the lower provider id (earlier catalogue entries).
fn select_mapped_services(rows: &[Value]) -> Vec<MappedService> {
    let mut best: HashMap<&'static str, (u8, u64, MappedService)> = HashMap::new();
    for row in rows {
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(slug) = map_service(name) else {
            continue;
        };
        let id = row
            .get("ID")
            .or_else(|| row.get("id"))
            .map(value_key)
            .filter(|s| !s.is_empty());
        let Some(provider_id) = id else {
            continue;
        };
        let id_num = provider_id.parse::<u64>().unwrap_or(u64::MAX);
        let score = map_service_score(name, slug);
        let candidate = MappedService {
            slug: slug.to_string(),
            provider_id,
        };
        match best.get(slug) {
            Some((best_score, best_id, _))
                if score > *best_score || (score == *best_score && id_num >= *best_id) => {}
            _ => {
                best.insert(slug, (score, id_num, candidate));
            }
        }
    }
    let mut out: Vec<_> = best.into_values().map(|(_, _, service)| service).collect();
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

fn country_code_from_success_row(row: &Value) -> Option<String> {
    row.get("short_name")
        .or_else(|| row.get("country_code"))
        .or_else(|| row.get("iso"))
        .and_then(Value::as_str)
        .map(|s| s.to_uppercase())
        .or_else(|| {
            row.get("name")
                .and_then(Value::as_str)
                .and_then(map_country)
        })
}

fn skus_from_success_rows(
    slug: &str,
    provider_product: &str,
    rows: &[Value],
    currency: &str,
) -> Vec<OfferSku> {
    let mut skus = Vec::new();
    for row in rows {
        let Some(country_code) = country_code_from_success_row(row) else {
            continue;
        };
        let provider_country = row
            .get("country_id")
            .or_else(|| row.get("country"))
            .map(value_key)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| country_code.clone());
        let stock = row
            .get("stock")
            .or_else(|| row.get("amount"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if stock <= 0 {
            continue;
        }
        let cost = row
            .get("price")
            .or_else(|| row.get("low_price"))
            .or_else(|| row.get("cost"))
            .and_then(json_decimal);
        let Some(cost) = cost else {
            continue;
        };
        let Some(raw) = row
            .get("success_rate")
            .or_else(|| row.get("rate"))
            .or_else(|| row.get("success"))
            .and_then(json_decimal)
        else {
            continue;
        };
        let Some(success_rate) = crate::number_offers::parse_success_rate(raw) else {
            continue;
        };
        skus.push(OfferSku {
            provider: "smspool",
            product_slug: slug.to_string(),
            country_code,
            provider_product: provider_product.to_string(),
            provider_country,
            provider_operator: None,
            cost,
            currency: currency.to_string(),
            success_rate,
            stock: i32::try_from(stock).unwrap_or(i32::MAX),
        });
    }
    skus
}

fn parse_smspool_check(body: &Value) -> ActivationCheck {
    let status = body
        .get("status")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            body.get("status")
                .and_then(Value::as_str)
                .and_then(|s| s.parse().ok())
        });
    let code = body
        .get("sms")
        .or_else(|| body.get("code"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let full = body
        .get("full_sms")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let messages = match (&code, &full) {
        (None, None) => Vec::new(),
        (Some(code), text) => vec![Sms {
            sender: None,
            text: text.clone().unwrap_or_else(|| code.clone()),
            code: Some(code.clone()),
            received_at: None,
            provider_message_id: None,
        }],
        (None, Some(text)) => vec![Sms {
            sender: None,
            text: text.clone(),
            code: None,
            received_at: None,
            provider_message_id: None,
        }],
    };
    let lifecycle = match status {
        Some(3) | Some(5) | Some(6) => ActivationLifecycle::Closed,
        _ => ActivationLifecycle::Open,
    };
    ActivationCheck {
        messages,
        lifecycle,
        expires_at: None,
    }
}

fn parse_balance_json(body: &Value) -> anyhow::Result<Decimal> {
    let raw = body.get("balance").or_else(|| body.get("Balance"));
    match raw {
        Some(Value::String(s)) => Decimal::from_str(s.trim())
            .map_err(|e| anyhow::anyhow!("smspool balance unreadable: {e}")),
        Some(Value::Number(n)) => n
            .as_f64()
            .and_then(|f| Decimal::from_str(&f.to_string()).ok())
            .or_else(|| n.as_i64().map(Decimal::from))
            .ok_or_else(|| anyhow::anyhow!("smspool balance unreadable")),
        _ => anyhow::bail!("smspool balance missing"),
    }
}

fn map_country(name: &str) -> Option<String> {
    let n = name.to_ascii_lowercase();
    let code = match n.as_str() {
        "nigeria" | "ng" => "NG",
        "united states" | "usa" | "us" => "US",
        "united kingdom" | "england" | "gb" | "uk" => "GB",
        "ghana" | "gh" => "GH",
        "south africa" | "za" => "ZA",
        "kenya" | "ke" => "KE",
        _ => return None,
    };
    Some(code.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;
    use serde_json::json;

    #[test]
    fn balance_error_json_is_unavailable_not_ambiguous() {
        let body = json!({"success": 0, "type": "BALANCE_ERROR", "message": "Not enough balance"});
        let err = smspool_error_from_json(&body).expect("error");
        match err {
            PurchaseError::Rejected(ApiError::ServiceUnavailable(msg)) => {
                assert!(msg.contains("isn't available right now"));
                assert!(!msg.contains("charged"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn out_of_stock_json_keeps_stock_copy() {
        let body = json!({"success": 0, "type": "OUT_OF_STOCK"});
        let err = smspool_error_from_json(&body).expect("error");
        match err {
            PurchaseError::Rejected(ApiError::ServiceUnavailable(msg)) => {
                assert!(msg.contains("out of stock"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn empty_wallet_is_zero() {
        assert_eq!(parse_balance_json(&json!({"balance": "0.00"})).unwrap(), dec!(0));
        assert_eq!(parse_balance_json(&json!({"balance": 1.5})).unwrap(), dec!(1.5));
    }

    #[test]
    fn success_rows_parse_short_name_and_published_percent() {
        let rows = vec![
            json!({
                "country_id": 1,
                "name": "United States",
                "short_name": "US",
                "price": "0.80",
                "success_rate": "100",
                "stock": 12
            }),
            json!({
                "country_id": 2,
                "name": "United Kingdom",
                "short_name": "GB",
                "price": "0.10",
                "success_rate": "1",
                "stock": 4
            }),
            json!({
                "country_id": 14,
                "name": "Nigeria",
                "short_name": "NG",
                "price": "0.81",
                "success_rate": 30,
                "stock": 0
            }),
        ];
        let skus = skus_from_success_rows("whatsapp", "1012", &rows, "USD");
        assert_eq!(skus.len(), 2);
        assert_eq!(skus[0].country_code, "US");
        assert_eq!(skus[0].provider_country, "1");
        assert_eq!(skus[0].provider_product, "1012");
        assert_eq!(skus[0].success_rate, dec!(100));
        assert_eq!(skus[1].country_code, "GB");
        assert_eq!(skus[1].success_rate, dec!(1));
        assert_eq!(skus[1].provider_country, "2");
    }

    #[test]
    fn mapped_services_prefer_primary_google() {
        let rows = vec![
            json!({"ID": 396, "name": "Google Voice"}),
            json!({"ID": 395, "name": "Google/Gmail"}),
            json!({"ID": 1012, "name": "WhatsApp"}),
            json!({"ID": 9999, "name": "Unknown Service"}),
        ];
        let mapped = select_mapped_services(&rows);
        assert_eq!(mapped.len(), 2);
        let google = mapped.iter().find(|s| s.slug == "google").unwrap();
        assert_eq!(google.provider_id, "395");
        let whatsapp = mapped.iter().find(|s| s.slug == "whatsapp").unwrap();
        assert_eq!(whatsapp.provider_id, "1012");
    }

    #[test]
    fn check_status_three_with_code_is_closed() {
        let check = parse_smspool_check(&json!({
            "status": 3,
            "sms": "12345",
            "full_sms": "Full code: 12345"
        }));
        assert_eq!(check.lifecycle, ActivationLifecycle::Closed);
        assert_eq!(check.messages.len(), 1);
        assert_eq!(check.messages[0].code.as_deref(), Some("12345"));
        assert!(check.messages[0].received_at.is_none());
    }

    #[test]
    fn check_status_three_without_code_is_closed() {
        let check = parse_smspool_check(&json!({ "status": 3 }));
        assert_eq!(check.lifecycle, ActivationLifecycle::Closed);
        assert!(check.messages.is_empty());
    }

    #[test]
    fn check_unknown_status_stays_open() {
        let check = parse_smspool_check(&json!({ "status": 99 }));
        assert_eq!(check.lifecycle, ActivationLifecycle::Open);
        assert!(check.messages.is_empty());
    }
}
