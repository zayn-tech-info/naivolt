//! `handler_api.php` adapter — SMS-Activate and the suppliers that clone it.
//!
//! SMS-Activate, SMSHub, Tiger SMS and DaisySMS all speak the same protocol:
//! one GET endpoint, an `action` parameter, and **plain-text replies**, not
//! JSON. One adapter serves all four; they differ only by base URL, currency
//! and which services they carry.
//!
//! Plain text is the hazard. `getNumber` answers `ACCESS_NUMBER:id:phone` on
//! success and a bare word like `NO_NUMBERS` on failure — both with HTTP 200.
//! The same shape caused live 5SIM orders to sit in review holding a customer's
//! naira, so every unrecognised reply here is treated as a possible charge
//! (`Ambiguous`) and every recognised refusal releases the money.
//!
//! Customer JSON never names these suppliers.

use crate::error::{ApiError, ApiResult};
use crate::number_offers::OfferSku;
use crate::number_provider::{
    Activation, ActivationCheck, PurchaseError, Sms, COPY_OUT_OF_STOCK,
    COPY_SOURCE_UNAVAILABLE,
};
use crate::number_smspool::{map_country, map_service};
use chrono::Utc;
use rust_decimal::Decimal;
use serde_json::Value;
use std::collections::HashMap;
use std::str::FromStr;
use std::time::Duration;

/// These suppliers publish stock and price but not a delivery rate. Starting an
/// unproven SKU mid-pack lets `number_aggregator` rank it on real orders rather
/// than on a number nobody published — a claimed 99% is what made the 5SIM
/// catalogue untrustworthy in the first place.
pub const UNPROVEN_SUCCESS_RATE: Decimal = Decimal::from_parts(50, 0, 0, false, 0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivateFlavor {
    SmsActivate,
    SmsHub,
    TigerSms,
    DaisySms,
}

impl ActivateFlavor {
    /// The `provider` value written to `number_offer_sources` and
    /// `number_orders`. Must match migration 0024's CHECK constraint.
    pub fn provider(self) -> &'static str {
        match self {
            ActivateFlavor::SmsActivate => "smsactivate",
            ActivateFlavor::SmsHub => "smshub",
            ActivateFlavor::TigerSms => "tigersms",
            ActivateFlavor::DaisySms => "daisysms",
        }
    }

    pub fn default_base(self) -> &'static str {
        match self {
            ActivateFlavor::SmsActivate => "https://api.sms-activate.ae/stubs/handler_api.php",
            ActivateFlavor::SmsHub => "https://smshub.org/stubs/handler_api.php",
            ActivateFlavor::TigerSms => "https://api.tiger-sms.com/stubs/handler_api.php",
            ActivateFlavor::DaisySms => "https://daisysms.com/stubs/handler_api.php",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "smsactivate" | "sms-activate" => Some(ActivateFlavor::SmsActivate),
            "smshub" => Some(ActivateFlavor::SmsHub),
            "tigersms" | "tiger-sms" => Some(ActivateFlavor::TigerSms),
            "daisysms" | "daisy-sms" => Some(ActivateFlavor::DaisySms),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct ActivateProvider {
    http: reqwest::Client,
    api_key: String,
    base: String,
    currency: String,
    flavor: ActivateFlavor,
}

impl ActivateProvider {
    pub fn new(
        flavor: ActivateFlavor,
        api_key: String,
        currency: Option<String>,
        base: Option<String>,
    ) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            api_key,
            base: base
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| flavor.default_base().to_owned()),
            currency: currency
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| default_currency(flavor).to_owned()),
            flavor,
        }
    }

    pub fn provider(&self) -> &'static str {
        self.flavor.provider()
    }

    /// Mirrors `SmsPoolProvider::currency`; kept so every adapter exposes the
    /// unit its costs are quoted in.
    #[allow(dead_code)]
    pub fn currency(&self) -> &str {
        &self.currency
    }

    async fn get(&self, params: &[(&str, &str)]) -> Result<String, reqwest::Error> {
        let mut query: Vec<(&str, &str)> = vec![("api_key", self.api_key.as_str())];
        query.extend_from_slice(params);
        self.http
            .get(&self.base)
            .query(&query)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await
    }

    /// `getNumber` → `ACCESS_NUMBER:id:phone`.
    pub async fn buy(
        &self,
        country: &str,
        product: &str,
    ) -> Result<Activation, PurchaseError> {
        let body = self
            .get(&[
                ("action", "getNumber"),
                ("service", product),
                ("country", country),
            ])
            .await
            .map_err(|e| {
                tracing::warn!(provider = self.provider(), error = %e, "activate buy failed");
                crate::number_provider::classify_buy_transport(&e)
            })?;
        match parse_buy(&body) {
            Ok(mut activation) => {
                activation.cost_currency = Some(self.currency.clone());
                Ok(activation)
            }
            Err(err) => {
                tracing::warn!(provider = self.provider(), "activate buy rejected");
                Err(err)
            }
        }
    }

    /// `getStatus` → `STATUS_OK:code`, `STATUS_WAIT_CODE`, `STATUS_CANCEL`.
    pub async fn check(&self, order_id: &str) -> ApiResult<ActivationCheck> {
        let body = self
            .get(&[("action", "getStatus"), ("id", order_id)])
            .await
            .map_err(|e| {
                tracing::warn!(provider = self.provider(), error = %e, "activate check failed");
                ApiError::ServiceUnavailable("We couldn't reach the number supplier.".into())
            })?;
        Ok(parse_status(&body))
    }

    /// `setStatus&status=8` hands the number back. Best effort, like 5SIM.
    pub async fn cancel(&self, order_id: &str) -> ApiResult<()> {
        self.get(&[("action", "setStatus"), ("id", order_id), ("status", "8")])
            .await
            .map_err(|e| {
                tracing::warn!(provider = self.provider(), error = %e, "activate cancel failed");
                ApiError::ServiceUnavailable("We couldn't reach the number supplier.".into())
            })?;
        Ok(())
    }

    /// Build offer SKUs from the live catalogue.
    ///
    /// Service codes and country ids are read from the supplier rather than
    /// hardcoded: `wa` for WhatsApp is stable, but guessing the code for a
    /// less common app buys the wrong service with a customer's money.
    pub async fn fetch_skus(&self) -> anyhow::Result<Vec<OfferSku>> {
        let countries = self.fetch_countries().await?;
        if countries.is_empty() {
            anyhow::bail!("{} returned no mappable countries", self.provider());
        }
        let services = self.fetch_services().await?;
        if services.is_empty() {
            anyhow::bail!("{} returned no mappable services", self.provider());
        }
        let prices: Value = serde_json::from_str(&self.get(&[("action", "getPrices")]).await?)
            .map_err(|e| anyhow::anyhow!("{} getPrices was not JSON: {e}", self.provider()))?;
        Ok(skus_from_prices(
            self.flavor.provider(),
            &prices,
            &countries,
            &services,
            &self.currency,
        ))
    }

    /// Supplier country id → ISO code, for the countries Naivolt sells.
    async fn fetch_countries(&self) -> anyhow::Result<HashMap<String, String>> {
        let body = self.get(&[("action", "getCountries")]).await?;
        let raw: Value = serde_json::from_str(&body)
            .map_err(|e| anyhow::anyhow!("{} getCountries was not JSON: {e}", self.provider()))?;
        let mut out = HashMap::new();
        let Some(rows) = raw.as_object() else {
            return Ok(out);
        };
        for (id, row) in rows {
            let name = row
                .get("eng")
                .or_else(|| row.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(code) = map_country(name) {
                out.insert(id.clone(), code);
            }
        }
        Ok(out)
    }

    /// Supplier service code → Naivolt product slug.
    async fn fetch_services(&self) -> anyhow::Result<HashMap<String, String>> {
        let body = self.get(&[("action", "getServicesList")]).await?;
        let raw: Value = serde_json::from_str(&body).map_err(|e| {
            anyhow::anyhow!("{} getServicesList was not JSON: {e}", self.provider())
        })?;
        let rows = raw
            .get("services")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut out = HashMap::new();
        for row in rows {
            let code = row
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = row.get("name").and_then(Value::as_str).unwrap_or_default();
            if code.is_empty() {
                continue;
            }
            if let Some(slug) = map_service(name) {
                // First mapping wins; the list is ordered by popularity.
                out.entry(code).or_insert_with(|| slug.to_string());
            }
        }
        Ok(out)
    }
}

fn default_currency(flavor: ActivateFlavor) -> &'static str {
    match flavor {
        // SMS-Activate and its clones bill in roubles; DaisySMS in dollars.
        ActivateFlavor::SmsActivate | ActivateFlavor::SmsHub | ActivateFlavor::TigerSms => "RUB",
        ActivateFlavor::DaisySms => "USD",
    }
}

/// `ACCESS_NUMBER:id:phone` on success; a bare token otherwise.
///
/// Anything unrecognised is `Ambiguous`, never a refusal: these suppliers reply
/// HTTP 200 to everything, so an unknown word may still have taken the money.
pub fn parse_buy(body: &str) -> Result<Activation, PurchaseError> {
    let trimmed = body.trim();
    if let Some(rest) = trimmed.strip_prefix("ACCESS_NUMBER:") {
        let mut parts = rest.splitn(2, ':');
        let id = parts.next().unwrap_or_default().trim();
        let phone = parts.next().unwrap_or_default().trim();
        if id.is_empty() || phone.is_empty() {
            return Err(PurchaseError::Ambiguous);
        }
        return Ok(Activation {
            provider_order_id: id.to_string(),
            phone: normalise_phone(phone),
            cost: None,
            cost_currency: None,
            expires_at: None,
        });
    }
    Err(classify_activate_error(trimmed))
}

/// Map a plain-text refusal onto the buy loop's vocabulary.
///
/// `try_next_source` advances on "out of stock" and "isn't available right
/// now", so a supplier that is dry, broke or misconfigured steps aside and lets
/// the next one try instead of failing the customer's purchase outright.
pub fn classify_activate_error(token: &str) -> PurchaseError {
    let upper = token.trim().to_ascii_uppercase();
    match upper.as_str() {
        "NO_NUMBERS" | "NO_NUMBER" => {
            PurchaseError::Rejected(ApiError::ServiceUnavailable(COPY_OUT_OF_STOCK.into()))
        }
        // Our balance, our problem — never the customer's, and never a reason
        // to abandon a sale another supplier can fill.
        "NO_BALANCE" | "NO_MONEY" | "NO_BALANCE_FORWARD" => {
            PurchaseError::Rejected(ApiError::ServiceUnavailable(COPY_SOURCE_UNAVAILABLE.into()))
        }
        // Configuration faults. Nothing was bought, so release the hold and
        // move on; the alert belongs in the logs, not in front of a customer.
        "BAD_KEY" | "BAD_ACTION" | "BAD_SERVICE" | "WRONG_SERVICE" | "WRONG_COUNTRY"
        | "BAD_STATUS" | "ERROR_NO_KEY" | "WRONG_MAX_PRICE" | "ACCOUNT_INACTIVE" => {
            PurchaseError::Rejected(ApiError::ServiceUnavailable(COPY_SOURCE_UNAVAILABLE.into()))
        }
        // Rate limits and server faults may or may not have reserved a number.
        "ERROR_SQL" | "" => PurchaseError::Ambiguous,
        _ => PurchaseError::Ambiguous,
    }
}

/// `STATUS_OK:code` delivered; `STATUS_WAIT_CODE` still open;
/// `STATUS_CANCEL` finished.
pub fn parse_status(body: &str) -> ActivationCheck {
    let trimmed = body.trim();
    if let Some(code) = trimmed.strip_prefix("STATUS_OK:") {
        let code = code.trim();
        if code.is_empty() {
            return ActivationCheck::open();
        }
        return ActivationCheck::open()
            .with_messages(vec![Sms {
                sender: None,
                text: code.to_string(),
                code: Some(code.to_string()),
                received_at: Some(Utc::now()),
                provider_message_id: None,
            }])
            .with_closed_lifecycle();
    }
    match trimmed.to_ascii_uppercase().as_str() {
        // The number is spent: cancelled, refunded, or the window closed.
        "STATUS_CANCEL" | "ACCESS_CANCEL" | "STATUS_REVOKE" | "NO_ACTIVATION" => {
            ActivationCheck::closed()
        }
        // Waiting, or waiting for a resend — both still live.
        _ => ActivationCheck::open(),
    }
}

/// These suppliers return bare digits; the app dials E.164.
fn normalise_phone(raw: &str) -> String {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return raw.to_string();
    }
    format!("+{digits}")
}

/// `getPrices` → `{"<country id>": {"<service code>": {"cost": n, "count": n}}}`.
pub fn skus_from_prices(
    provider: &'static str,
    prices: &Value,
    countries: &HashMap<String, String>,
    services: &HashMap<String, String>,
    currency: &str,
) -> Vec<OfferSku> {
    let mut out = Vec::new();
    let Some(by_country) = prices.as_object() else {
        return out;
    };
    for (country_id, offered) in by_country {
        let Some(country_code) = countries.get(country_id) else {
            continue;
        };
        let Some(by_service) = offered.as_object() else {
            continue;
        };
        for (service_code, row) in by_service {
            let Some(slug) = services.get(service_code) else {
                continue;
            };
            let Some(cost) = row.get("cost").and_then(json_decimal) else {
                continue;
            };
            let stock = row
                .get("count")
                .and_then(json_decimal)
                .and_then(|d| i32::try_from(d.trunc().mantissa()).ok())
                .unwrap_or(0);
            if cost <= Decimal::ZERO || stock <= 0 {
                continue;
            }
            out.push(OfferSku {
                provider,
                product_slug: slug.clone(),
                country_code: country_code.clone(),
                provider_product: service_code.clone(),
                provider_country: country_id.clone(),
                provider_operator: None,
                cost,
                currency: currency.to_string(),
                success_rate: UNPROVEN_SUCCESS_RATE,
                stock,
            });
        }
    }
    out.sort_by(|a, b| {
        a.country_code
            .cmp(&b.country_code)
            .then_with(|| a.product_slug.cmp(&b.product_slug))
            .then_with(|| a.provider_product.cmp(&b.provider_product))
    });
    out
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_bought_number_is_parsed_and_dialable() {
        let activation = parse_buy("ACCESS_NUMBER:1234567:79181234567").unwrap();
        assert_eq!(activation.provider_order_id, "1234567");
        assert_eq!(activation.phone, "+79181234567");
    }

    #[test]
    fn a_number_that_already_carries_a_plus_is_not_doubled() {
        let activation = parse_buy("ACCESS_NUMBER:99:+2348012345678").unwrap();
        assert_eq!(activation.phone, "+2348012345678");
    }

    #[test]
    fn a_truncated_access_line_is_ambiguous_not_a_number() {
        // Half a reply must never become an order with an empty phone.
        assert!(matches!(
            parse_buy("ACCESS_NUMBER:1234567"),
            Err(PurchaseError::Ambiguous)
        ));
        assert!(matches!(
            parse_buy("ACCESS_NUMBER::79181234567"),
            Err(PurchaseError::Ambiguous)
        ));
    }

    #[test]
    fn dry_stock_steps_aside_so_the_next_supplier_is_tried() {
        let err = match parse_buy("NO_NUMBERS") {
            Err(PurchaseError::Rejected(err)) => err,
            _ => panic!("expected a refusal, got a number"),
        };
        assert!(crate::number_provider::try_next_source(&err));
    }

    #[test]
    fn our_empty_balance_is_never_the_customers_problem() {
        let err = match parse_buy("NO_BALANCE") {
            Err(PurchaseError::Rejected(err)) => err,
            _ => panic!("expected a refusal, got a number"),
        };
        assert!(crate::number_provider::try_next_source(&err));
        assert!(!err.to_string().contains("balance"), "{err}");
    }

    #[test]
    fn a_bad_key_steps_aside_rather_than_failing_the_sale() {
        let err = match parse_buy("BAD_KEY") {
            Err(PurchaseError::Rejected(err)) => err,
            _ => panic!("expected a refusal, got a number"),
        };
        assert!(crate::number_provider::try_next_source(&err));
    }

    #[test]
    fn an_unknown_reply_is_ambiguous_because_it_may_have_charged_us() {
        // The 5SIM lesson: HTTP 200 plus a word we do not know is not a refusal.
        assert!(matches!(
            parse_buy("SOMETHING_NEW_THEY_ADDED"),
            Err(PurchaseError::Ambiguous)
        ));
        assert!(matches!(parse_buy(""), Err(PurchaseError::Ambiguous)));
    }

    #[test]
    fn a_delivered_code_closes_the_activation() {
        let check = parse_status("STATUS_OK:123456");
        assert_eq!(check.messages.len(), 1);
        assert_eq!(check.messages[0].code.as_deref(), Some("123456"));
        assert_eq!(
            check.lifecycle,
            crate::number_provider::ActivationLifecycle::Closed
        );
    }

    #[test]
    fn waiting_and_resend_stay_open_but_cancel_closes() {
        use crate::number_provider::ActivationLifecycle::{Closed, Open};
        assert_eq!(parse_status("STATUS_WAIT_CODE").lifecycle, Open);
        assert_eq!(parse_status("STATUS_WAIT_RESEND").lifecycle, Open);
        assert_eq!(parse_status("STATUS_CANCEL").lifecycle, Closed);
        assert_eq!(parse_status("NO_ACTIVATION").lifecycle, Closed);
    }

    #[test]
    fn an_empty_code_does_not_deliver_a_blank_message() {
        let check = parse_status("STATUS_OK:");
        assert!(check.messages.is_empty());
        assert_eq!(
            check.lifecycle,
            crate::number_provider::ActivationLifecycle::Open
        );
    }

    #[test]
    fn prices_become_skus_only_for_mapped_countries_and_services() {
        let countries = HashMap::from([("19".to_string(), "NG".to_string())]);
        let services = HashMap::from([("wa".to_string(), "whatsapp".to_string())]);
        let prices = json!({
            "19": {
                "wa": {"cost": 12.5, "count": 40},
                "zz": {"cost": 3.0,  "count": 10}
            },
            "999": { "wa": {"cost": 1.0, "count": 5} }
        });
        let skus = skus_from_prices("smsactivate", &prices, &countries, &services, "RUB");
        assert_eq!(skus.len(), 1, "unmapped country and service must be dropped");
        assert_eq!(skus[0].country_code, "NG");
        assert_eq!(skus[0].product_slug, "whatsapp");
        assert_eq!(skus[0].provider_product, "wa");
        assert_eq!(skus[0].provider_country, "19");
        assert_eq!(skus[0].stock, 40);
        assert_eq!(skus[0].success_rate, UNPROVEN_SUCCESS_RATE);
    }

    #[test]
    fn empty_stock_is_not_listed() {
        let countries = HashMap::from([("19".to_string(), "NG".to_string())]);
        let services = HashMap::from([("wa".to_string(), "whatsapp".to_string())]);
        let prices = json!({"19": {"wa": {"cost": 12.5, "count": 0}}});
        assert!(skus_from_prices("smsactivate", &prices, &countries, &services, "RUB").is_empty());
    }

    #[test]
    fn the_unproven_rate_is_a_legal_success_rate() {
        // number_offer_sources requires 0 < rate <= 100.
        assert!(UNPROVEN_SUCCESS_RATE > Decimal::ZERO);
        assert!(UNPROVEN_SUCCESS_RATE <= Decimal::from(100));
        assert!(crate::number_offers::parse_success_rate(UNPROVEN_SUCCESS_RATE).is_some());
    }

    #[test]
    fn every_flavor_round_trips_its_provider_name() {
        for flavor in [
            ActivateFlavor::SmsActivate,
            ActivateFlavor::SmsHub,
            ActivateFlavor::TigerSms,
            ActivateFlavor::DaisySms,
        ] {
            assert_eq!(ActivateFlavor::parse(flavor.provider()), Some(flavor));
            assert!(flavor.default_base().starts_with("https://"));
        }
    }
}
