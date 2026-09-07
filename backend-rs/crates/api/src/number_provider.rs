//! The virtual-number supplier — buy a number, watch for its code, cancel it.
//!
//! 5SIM in production; a deterministic stub anywhere without a key, so the buy
//! flow is exercisable on a laptop. `Config::validate_for_environment` refuses
//! the stub in production, for the same reason the payout stub is refused: a
//! flow that appears to hand out real numbers while inventing them is worse than
//! one that admits it cannot.
//!
//! This is a trait-shaped enum rather than direct calls because supplier death
//! is not hypothetical here. SMS-Activate — the largest service in this market —
//! shut down in December 2025 after ten years, moved its infrastructure to
//! another operator, and set a $30 minimum withdrawal that stranded every
//! smaller balance. Adding a second supplier has to be a new variant, not a
//! rewrite of the order path.
//!
//! Not in this module yet: catalogue sync. Prices are seeded (migration 0008)
//! and `number_prices.provider_cost` is written by hand until a sync job reads
//! `/v1/guest/prices` on a schedule.

use crate::error::{ApiError, ApiResult};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug)]
pub enum PurchaseError {
    Rejected(ApiError),
    Ambiguous,
}

impl PurchaseError {
    pub fn is_out_of_stock(&self) -> bool {
        matches!(
            self,
            PurchaseError::Rejected(ApiError::ServiceUnavailable(message))
                if message.contains("out of stock")
        )
    }
}

/// A number the supplier has assigned to one of our orders.
/// One message a number received.
#[derive(Debug, Clone)]
pub struct Sms {
    pub sender: Option<String>,
    pub text: String,
    pub code: Option<String>,
    pub received_at: Option<DateTime<Utc>>,
    pub provider_message_id: Option<String>,
}

/// Whether the supplier still says this activation can receive SMS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivationLifecycle {
    Open,
    Closed,
}

/// One provider check: messages plus whether the activation stays live.
#[derive(Clone, Debug)]
pub struct ActivationCheck {
    pub messages: Vec<Sms>,
    pub lifecycle: ActivationLifecycle,
    pub expires_at: Option<DateTime<Utc>>,
}

impl ActivationCheck {
    pub fn open() -> Self {
        Self {
            messages: Vec::new(),
            lifecycle: ActivationLifecycle::Open,
            expires_at: None,
        }
    }

    pub fn closed() -> Self {
        Self {
            messages: Vec::new(),
            lifecycle: ActivationLifecycle::Closed,
            expires_at: None,
        }
    }

    pub fn with_messages(mut self, messages: Vec<Sms>) -> Self {
        self.messages = messages;
        self
    }

    pub fn with_closed_lifecycle(mut self) -> Self {
        self.lifecycle = ActivationLifecycle::Closed;
        self
    }
}

pub struct Activation {
    pub provider_order_id: String,
    pub phone: String,
    /// What the supplier charged, in the supplier's own unit.
    pub cost: Option<Decimal>,
    /// The unit `cost` is denominated in, when we know it. 5SIM's API returns a
    /// bare number and does not name the currency, so this comes from config
    /// rather than from the wire — see `FIVESIM_CURRENCY`.
    pub cost_currency: Option<String>,
    /// When the supplier releases the number back to its pool.
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone)]
pub enum AnyNumberProvider {
    FiveSim(FiveSimProvider),
    /// Development only.
    Stub(StubProvider),
    #[cfg(test)]
    CountingStub(CountingStubProvider),
    #[cfg(test)]
    ScriptedStub(ScriptedStubProvider),
}

impl AnyNumberProvider {
    pub async fn buy(&self, country: &str, product: &str) -> Result<Activation, PurchaseError> {
        match self {
            AnyNumberProvider::FiveSim(p) => p.buy(country, product, ANY_OPERATOR).await,
            AnyNumberProvider::Stub(p) => p.buy(country, product).await,
            #[cfg(test)]
            AnyNumberProvider::CountingStub(p) => p.buy(country, product).await,
            #[cfg(test)]
            AnyNumberProvider::ScriptedStub(p) => p.buy(country, product).await,
        }
    }

    pub async fn check(&self, order_id: &str) -> ApiResult<ActivationCheck> {
        match self {
            AnyNumberProvider::FiveSim(p) => p.check(order_id).await,
            AnyNumberProvider::Stub(p) => p.check(order_id).await,
            #[cfg(test)]
            AnyNumberProvider::CountingStub(_) => Ok(ActivationCheck::open()),
            #[cfg(test)]
            AnyNumberProvider::ScriptedStub(p) => p.check(order_id).await,
        }
    }

    /// Hand the number back. Best-effort: a failure here costs us the number's
    /// price, never the user's — their refund does not wait on the supplier.
    pub async fn cancel(&self, order_id: &str) -> ApiResult<()> {
        match self {
            AnyNumberProvider::FiveSim(p) => p.cancel(order_id).await,
            AnyNumberProvider::Stub(_) => Ok(()),
            #[cfg(test)]
            AnyNumberProvider::CountingStub(_) => Ok(()),
            #[cfg(test)]
            AnyNumberProvider::ScriptedStub(_) => Ok(()),
        }
    }

    pub fn is_live(&self) -> bool {
        matches!(self, AnyNumberProvider::FiveSim(_))
    }

    pub async fn buy_with(
        &self,
        country: &str,
        product: &str,
        operator: &str,
    ) -> Result<Activation, PurchaseError> {
        match self {
            AnyNumberProvider::FiveSim(p) => p.buy(country, product, operator).await,
            AnyNumberProvider::Stub(p) => p.buy(country, product).await,
            #[cfg(test)]
            AnyNumberProvider::CountingStub(p) => p.buy(country, product).await,
            #[cfg(test)]
            AnyNumberProvider::ScriptedStub(p) => p.buy(country, product).await,
        }
    }
}

/// Primary supplier plus optional SMSPool. Old buy uses `primary`.
pub struct NumberProviders {
    pub primary: AnyNumberProvider,
    pub smspool: Option<crate::number_smspool::SmsPoolProvider>,
}

impl From<AnyNumberProvider> for NumberProviders {
    fn from(primary: AnyNumberProvider) -> Self {
        Self {
            primary,
            smspool: None,
        }
    }
}

impl std::ops::Deref for NumberProviders {
    type Target = AnyNumberProvider;
    fn deref(&self) -> &Self::Target {
        &self.primary
    }
}

impl NumberProviders {
    /// Real supplier money can move. FiveSim primary or a configured SMSPool
    /// both count; stub-only must never pair with live funding.
    pub fn is_live(&self) -> bool {
        self.primary.is_live() || self.smspool.is_some()
    }

    pub async fn buy_source(
        &self,
        provider: &str,
        country: &str,
        product: &str,
        operator: &str,
    ) -> Result<Activation, PurchaseError> {
        match provider {
            "smspool" => match &self.smspool {
                Some(pool) => pool.buy(country, product).await,
                None => Err(PurchaseError::Rejected(ApiError::ServiceUnavailable(
                    "That number is out of stock right now. Try another country.".into(),
                ))),
            },
            "fivesim" => self.primary.buy_with(country, product, operator).await,
            "stub" => self.primary.buy(country, product).await,
            _ => Err(PurchaseError::Rejected(ApiError::ServiceUnavailable(
                "We couldn't get a number just now. Nothing was charged.".into(),
            ))),
        }
    }

    pub async fn check_for(&self, provider: &str, order_id: &str) -> ApiResult<ActivationCheck> {
        match provider {
            "smspool" => match &self.smspool {
                Some(pool) => pool.check(order_id).await,
                None => self.primary.check(order_id).await,
            },
            _ => self.primary.check(order_id).await,
        }
    }

    pub async fn cancel_for(&self, provider: &str, order_id: &str) -> ApiResult<()> {
        match provider {
            "smspool" => match &self.smspool {
                Some(pool) => pool.cancel(order_id).await,
                None => self.primary.cancel(order_id).await,
            },
            _ => self.primary.cancel(order_id).await,
        }
    }
}

// ---------------------------------------------------------------------------

const FIVESIM_BASE: &str = "https://5sim.net/v1/user";
/// 5SIM lets you name an operator; "any" takes whichever pool has stock.
const ANY_OPERATOR: &str = "any";

#[derive(Clone)]
pub struct FiveSimProvider {
    http: reqwest::Client,
    api_key: String,
    currency: Option<String>,
}

#[derive(Deserialize)]
struct FiveSimOrder {
    id: i64,
    phone: String,
    #[serde(default)]
    price: Option<Decimal>,
    #[serde(default)]
    expires: Option<DateTime<Utc>>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    sms: Vec<FiveSimSms>,
}

#[derive(Deserialize)]
struct FiveSimSms {
    #[serde(default)]
    text: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    sender: Option<String>,
    /// 5SIM sends `date` on some routes and `created_at` on others.
    #[serde(default, alias = "created_at")]
    date: Option<DateTime<Utc>>,
    #[serde(default)]
    id: Option<serde_json::Value>,
}

impl FiveSimProvider {
    pub fn new(api_key: String, currency: Option<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            api_key,
            currency,
        }
    }

    async fn buy(
        &self,
        country: &str,
        product: &str,
        operator: &str,
    ) -> Result<Activation, PurchaseError> {
        let operator = if operator.trim().is_empty() {
            ANY_OPERATOR
        } else {
            operator
        };
        let url = format!("{FIVESIM_BASE}/buy/activation/{country}/{operator}/{product}");

        let response = self
            .http
            .get(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, %country, %product, "5sim buy failed");
                PurchaseError::Ambiguous
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(%status, %country, %product, "5sim buy rejected");

            // 5SIM answers in bare strings rather than codes. Only the
            // out-of-stock case is worth showing a user, because it is the only
            // one they can act on — everything else is ours to fix.
            let message = if body.contains("no free phones") || body.contains("no product") {
                "That number is out of stock right now. Try another country."
            } else if body.contains("not enough user balance") {
                // Our balance, not theirs. Say nothing about whose.
                "Numbers are briefly unavailable. Nothing was charged."
            } else {
                "We couldn't get a number just now. Nothing was charged."
            };
            let error = ApiError::ServiceUnavailable(message.into());
            return if status.is_server_error() {
                Err(PurchaseError::Ambiguous)
            } else {
                Err(PurchaseError::Rejected(error))
            };
        }

        let order: FiveSimOrder = response.json().await.map_err(|e| {
            tracing::warn!(error = %e, "5sim buy returned unreadable body");
            PurchaseError::Ambiguous
        })?;

        Ok(Activation {
            provider_order_id: order.id.to_string(),
            phone: order.phone,
            cost: order.price,
            cost_currency: self.currency.clone(),
            expires_at: order.expires,
        })
    }

    async fn check(&self, order_id: &str) -> ApiResult<ActivationCheck> {
        let response = self
            .http
            .get(format!("{FIVESIM_BASE}/check/{order_id}"))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, %order_id, "5sim check failed");
                ApiError::ServiceUnavailable("We couldn't check that number just now.".into())
            })?;

        if !response.status().is_success() {
            let status = response.status();
            tracing::warn!(%status, %order_id, "5sim check rejected");
            return Err(ApiError::ServiceUnavailable(
                "We couldn't check that number just now.".into(),
            ));
        }

        let order: FiveSimOrder = response.json().await.map_err(|e| {
            tracing::warn!(error = %e, "5sim check returned unreadable body");
            ApiError::ServiceUnavailable("We couldn't check that number just now.".into())
        })?;

        Ok(fivesim_activation_check(order))
    }

    async fn cancel(&self, order_id: &str) -> ApiResult<()> {
        let response = self
            .http
            .get(format!("{FIVESIM_BASE}/cancel/{order_id}"))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, %order_id, "5sim cancel failed");
                ApiError::ServiceUnavailable("We couldn't release that number.".into())
            })?;

        if !response.status().is_success() {
            tracing::warn!(status = %response.status(), %order_id, "5sim cancel rejected");
            return Err(ApiError::ServiceUnavailable(
                "That number can't be released just yet — try again in a moment.".into(),
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------

/// Development only. Hands out a fake number and always delivers a code, so the
/// happy path is walkable without spending real money. Refused in production.
#[derive(Clone)]
pub struct StubProvider;

#[cfg(test)]
#[derive(Clone, Default)]
pub struct CountingStubProvider {
    buy_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

#[cfg(test)]
impl CountingStubProvider {
    pub fn buy_calls(&self) -> usize {
        self.buy_calls.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn buy(&self, country: &str, product: &str) -> Result<Activation, PurchaseError> {
        self.buy_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        StubProvider.buy(country, product).await
    }
}

fn fivesim_activation_check(order: FiveSimOrder) -> ActivationCheck {
    let status = order.status.to_ascii_uppercase();
    let waiting = matches!(status.as_str(), "PENDING" | "RECEIVED");
    let closed = matches!(
        status.as_str(),
        "FINISHED" | "TIMEOUT" | "CANCELED" | "CANCELLED" | "BANNED"
    );
    let messages: Vec<Sms> = order
        .sms
        .into_iter()
        .map(|sms| Sms {
            sender: sms.sender,
            text: sms.text,
            code: sms.code,
            received_at: sms.date,
            provider_message_id: sms.id.and_then(|value| match value {
                serde_json::Value::String(text) if !text.is_empty() => Some(text),
                serde_json::Value::Number(number) => Some(number.to_string()),
                _ => None,
            }),
        })
        .collect();
    let lifecycle = if waiting && !closed {
        ActivationLifecycle::Open
    } else if closed || !waiting {
        ActivationLifecycle::Closed
    } else {
        ActivationLifecycle::Open
    };
    ActivationCheck {
        messages,
        lifecycle,
        expires_at: order.expires,
    }
}

fn stub_received() -> ActivationCheck {
    ActivationCheck::open().with_messages(vec![Sms {
        sender: Some("Naivolt".into()),
        text: "Your code is 123456".into(),
        code: Some("123456".into()),
        received_at: None,
        provider_message_id: None,
    }])
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum ScriptedBuy {
    Succeed,
    OutOfStock,
    Ambiguous,
}

/// Test helper: `check()` returns a scripted supplier view, including failures.
#[cfg(test)]
#[derive(Clone)]
pub struct ScriptedStubProvider {
    check: std::sync::Arc<std::sync::Mutex<Result<ActivationCheck, String>>>,
    buy: std::sync::Arc<std::sync::Mutex<ScriptedBuy>>,
}

#[cfg(test)]
impl ScriptedStubProvider {
    fn with_check(check: Result<ActivationCheck, String>) -> Self {
        Self {
            check: std::sync::Arc::new(std::sync::Mutex::new(check)),
            buy: std::sync::Arc::new(std::sync::Mutex::new(ScriptedBuy::Succeed)),
        }
    }

    pub fn received() -> Self {
        Self::with_check(Ok(stub_received()))
    }

    pub fn pending() -> Self {
        Self::with_check(Ok(ActivationCheck::open()))
    }

    pub fn closed() -> Self {
        Self::with_check(Ok(ActivationCheck::closed()))
    }

    pub fn timeout() -> Self {
        Self::closed()
    }

    pub fn complete() -> Self {
        Self::with_check(Ok(stub_received().with_closed_lifecycle()))
    }

    pub fn failing() -> Self {
        Self::with_check(Err("supplier check unavailable".into()))
    }

    pub fn malformed() -> Self {
        Self::failing()
    }

    pub fn out_of_stock() -> Self {
        let provider = Self::pending();
        *provider.buy.lock().unwrap() = ScriptedBuy::OutOfStock;
        provider
    }

    pub fn ambiguous() -> Self {
        let provider = Self::pending();
        *provider.buy.lock().unwrap() = ScriptedBuy::Ambiguous;
        provider
    }

    pub fn set_check(&self, next: Result<ActivationCheck, String>) {
        *self.check.lock().unwrap() = next;
    }

    async fn buy(&self, country: &str, product: &str) -> Result<Activation, PurchaseError> {
        let action = *self.buy.lock().unwrap();
        match action {
            ScriptedBuy::Succeed => StubProvider.buy(country, product).await,
            ScriptedBuy::OutOfStock => Err(PurchaseError::Rejected(ApiError::ServiceUnavailable(
                "That number is out of stock right now. Try another country.".into(),
            ))),
            ScriptedBuy::Ambiguous => Err(PurchaseError::Ambiguous),
        }
    }

    async fn check(&self, _order_id: &str) -> ApiResult<ActivationCheck> {
        let snapshot = self.check.lock().unwrap().clone();
        match snapshot {
            Ok(state) => Ok(state),
            Err(message) => Err(ApiError::ServiceUnavailable(message)),
        }
    }
}

impl StubProvider {
    async fn buy(&self, country: &str, product: &str) -> Result<Activation, PurchaseError> {
        let seed = uuid::Uuid::new_v4().simple().to_string();
        Ok(Activation {
            provider_order_id: format!("stub-{}", &seed[..12]),
            // Obviously fake on sight. A stub that looked like a real number
            // would eventually be read as one.
            phone: format!("+000{}", &seed[..9]),
            cost: None,
            cost_currency: None,
            expires_at: Some(Utc::now() + chrono::Duration::minutes(20)),
        })
        .inspect(|_| tracing::debug!(%country, %product, "stub number issued"))
    }

    async fn check(&self, _order_id: &str) -> ApiResult<ActivationCheck> {
        Ok(stub_received())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_provider_claims_it_is_live() {
        // `is_live` gates the provider label written onto every order. A stub
        // that claimed to be live would leave rows saying 5SIM sold a number it
        // has never heard of.
        assert!(
            AnyNumberProvider::FiveSim(FiveSimProvider::new("key".into(), Some("USD".into())))
                .is_live()
        );
        assert!(!AnyNumberProvider::Stub(StubProvider).is_live());
        assert!(
            !NumberProviders {
                primary: AnyNumberProvider::Stub(StubProvider),
                smspool: None,
            }
            .is_live()
        );
        assert!(
            NumberProviders {
                primary: AnyNumberProvider::Stub(StubProvider),
                smspool: Some(crate::number_smspool::SmsPoolProvider::new(
                    "key".into(),
                    Some("USD".into()),
                    None,
                )),
            }
            .is_live(),
            "SMSPool alone is enough for live number sales"
        );
    }

    #[tokio::test]
    async fn the_stub_never_hands_out_a_dialable_number() {
        // Anyone reading a stub number should see immediately that it is fake.
        // A plausible-looking one would eventually be dialled, or supported.
        let activation = StubProvider.buy("nigeria", "whatsapp").await.unwrap();
        assert!(activation.phone.starts_with("+000"));
        assert!(activation.provider_order_id.starts_with("stub-"));
        assert!(activation.cost.is_none(), "a stub must not invent a cost");
    }

    fn fivesim_order(body: serde_json::Value) -> FiveSimOrder {
        serde_json::from_value(body).expect("fixture must match the 5SIM check body")
    }

    #[test]
    fn pending_and_received_stay_open_and_keep_sms() {
        for status in ["PENDING", "pending", "RECEIVED", "Received"] {
            let check = fivesim_activation_check(fivesim_order(serde_json::json!({
                "id": 1,
                "phone": "+000",
                "status": status,
                "sms": [{
                    "text": "Your code is 111111",
                    "code": "111111",
                    "sender": "WhatsApp",
                    "id": 77
                }]
            })));
            assert_eq!(
                check.lifecycle,
                ActivationLifecycle::Open,
                "status {status} must stay open"
            );
            assert_eq!(check.messages.len(), 1);
            assert_eq!(check.messages[0].code.as_deref(), Some("111111"));
            assert_eq!(check.messages[0].provider_message_id.as_deref(), Some("77"));
        }
    }

    #[test]
    fn terminal_status_stores_final_sms_then_closes() {
        for status in ["FINISHED", "finished", "TIMEOUT", "CANCELED", "CANCELLED", "BANNED"] {
            let check = fivesim_activation_check(fivesim_order(serde_json::json!({
                "id": 2,
                "phone": "+000",
                "status": status,
                "sms": [{
                    "text": "final 999999",
                    "code": "999999",
                    "id": "sms-9"
                }]
            })));
            assert_eq!(
                check.lifecycle,
                ActivationLifecycle::Closed,
                "status {status} must close"
            );
            assert_eq!(check.messages.len(), 1);
            assert_eq!(check.messages[0].code.as_deref(), Some("999999"));
        }
    }

    #[test]
    fn five_sim_http_paths_never_include_finish() {
        let source = include_str!("number_provider.rs");
        let finish_path = ["{FIVESIM_BASE}", "/finish"].concat();
        assert!(
            !source.contains(&finish_path),
            "this slice must not call 5SIM finish"
        );
        assert!(source.contains("{FIVESIM_BASE}/check/{order_id}"));
        assert!(source.contains("{FIVESIM_BASE}/cancel/{order_id}"));
    }

    #[tokio::test]
    async fn timeout_and_malformed_checks_are_closed_or_errors() {
        // covers: AC-6 scripted timeout (closed, no SMS) and malformed check Err
        let timeout = AnyNumberProvider::ScriptedStub(ScriptedStubProvider::timeout())
            .check("any")
            .await
            .unwrap();
        assert_eq!(timeout.lifecycle, ActivationLifecycle::Closed);
        assert!(timeout.messages.is_empty());
        assert!(
            AnyNumberProvider::ScriptedStub(ScriptedStubProvider::malformed())
                .check("any")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn out_of_stock_buy_is_a_rejected_purchase() {
        let err = match AnyNumberProvider::ScriptedStub(ScriptedStubProvider::out_of_stock())
            .buy("nigeria", "whatsapp")
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("out of stock must refuse the buy"),
        };
        assert!(err.is_out_of_stock());
    }

    #[tokio::test]
    async fn an_ambiguous_buy_is_not_a_refusal() {
        let err = match AnyNumberProvider::ScriptedStub(ScriptedStubProvider::ambiguous())
            .buy("nigeria", "whatsapp")
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("an ambiguous buy must not look like success"),
        };
        assert!(matches!(err, PurchaseError::Ambiguous));
        assert!(!err.is_out_of_stock());
    }
}
