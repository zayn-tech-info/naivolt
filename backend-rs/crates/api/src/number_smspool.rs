//! SMSPool HTTP adapter. Customer JSON never names this supplier.

use crate::error::{ApiError, ApiResult};
use crate::number_offers::OfferSku;
use crate::number_provider::{Activation, ActivationState, PurchaseError, Sms};
use chrono::Utc;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;

const DEFAULT_BASE: &str = "https://api.smspool.net";

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

    pub async fn fetch_skus(&self) -> anyhow::Result<Vec<OfferSku>> {
        let success = self.fetch_success_index().await?;
        let stock_url = format!("{}/sms/stock", self.base.trim_end_matches('/'));
        let response = self
            .http
            .get(&stock_url)
            .query(&[("key", self.api_key.as_str())])
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!("smspool stock refused");
        }
        let body: Value = response.json().await?;
        let rows = body.as_array().cloned().unwrap_or_default();
        let mut skus = Vec::new();
        for row in rows {
            let service = row
                .get("service")
                .or_else(|| row.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(slug) = map_service(service) else {
                continue;
            };
            let country_code = row
                .get("country_code")
                .or_else(|| row.get("iso"))
                .and_then(Value::as_str)
                .map(|s| s.to_uppercase())
                .or_else(|| {
                    row.get("country")
                        .and_then(Value::as_str)
                        .and_then(map_country)
                });
            let Some(country_code) = country_code else {
                continue;
            };
            let provider_country = row
                .get("country")
                .and_then(Value::as_str)
                .unwrap_or(&country_code)
                .to_string();
            let provider_product = row
                .get("service_id")
                .or_else(|| row.get("id"))
                .map(|v| value_key(v))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| service.to_string());
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
                .or_else(|| row.get("cost"))
                .and_then(json_decimal);
            let Some(cost) = cost else {
                continue;
            };
            let success_key = format!("{slug}:{country_code}");
            let Some(success_rate) = success.get(&success_key).copied() else {
                continue;
            };
            skus.push(OfferSku {
                provider: "smspool",
                product_slug: slug.to_string(),
                country_code,
                provider_product,
                provider_country,
                provider_operator: None,
                cost,
                currency: self.currency.clone(),
                success_rate,
                stock: i32::try_from(stock).unwrap_or(i32::MAX),
            });
        }
        Ok(skus)
    }

    async fn fetch_success_index(&self) -> anyhow::Result<HashMap<String, Decimal>> {
        let url = format!("{}/request/success_rate", self.base.trim_end_matches('/'));
        let response = self
            .http
            .post(&url)
            .form(&[("key", self.api_key.as_str())])
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!("smspool success_rate refused");
        }
        let body: Value = response.json().await?;
        let rows = body
            .as_array()
            .cloned()
            .or_else(|| body.get("data").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        let mut index = HashMap::new();
        for row in rows {
            let service = row
                .get("service")
                .or_else(|| row.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(slug) = map_service(service) else {
                continue;
            };
            let country_code = row
                .get("country_code")
                .or_else(|| row.get("iso"))
                .and_then(Value::as_str)
                .map(|s| s.to_uppercase())
                .or_else(|| {
                    row.get("country")
                        .and_then(Value::as_str)
                        .and_then(map_country)
                });
            let Some(country_code) = country_code else {
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
            let Some(rate) = crate::number_offers::parse_success_rate(raw) else {
                continue;
            };
            index.insert(format!("{slug}:{country_code}"), rate);
        }
        Ok(index)
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
                PurchaseError::Ambiguous
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(%status, "smspool buy rejected");
            let lower = body.to_ascii_lowercase();
            if lower.contains("stock") || lower.contains("available") {
                return Err(PurchaseError::Rejected(ApiError::ServiceUnavailable(
                    "That number is out of stock right now. Try another country.".into(),
                )));
            }
            return if status.is_server_error() {
                Err(PurchaseError::Ambiguous)
            } else {
                Err(PurchaseError::Rejected(ApiError::ServiceUnavailable(
                    "We couldn't get a number just now. Nothing was charged.".into(),
                )))
            };
        }
        let order: SmsPoolOrder = response.json().await.map_err(|e| {
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

    pub async fn check(&self, order_id: &str) -> ApiResult<ActivationState> {
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
        let status = body
            .get("status")
            .and_then(|v| v.as_i64())
            .or_else(|| body.get("status").and_then(Value::as_str).and_then(|s| s.parse().ok()));
        let code = body
            .get("sms")
            .or_else(|| body.get("code"))
            .and_then(Value::as_str)
            .map(|s| s.to_string());
        if let Some(code) = code.filter(|s| !s.is_empty()) {
            return Ok(ActivationState::Received {
                code: code.clone(),
                text: code.clone(),
                messages: vec![Sms {
                    sender: None,
                    text: code.clone(),
                    code: Some(code.clone()),
                    received_at: Some(Utc::now()),
                }],
            });
        }
        match status {
            Some(1) | Some(8) => Ok(ActivationState::Pending),
            Some(3) | Some(4) => Ok(ActivationState::Pending),
            Some(5) | Some(6) => Ok(ActivationState::Finished),
            _ => Ok(ActivationState::Pending),
        }
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
