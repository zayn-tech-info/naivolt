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

/// A number the supplier has assigned to one of our orders.
/// One message a number received.
#[derive(Debug, Clone)]
pub struct Sms {
    pub sender: Option<String>,
    pub text: String,
    pub code: Option<String>,
    pub received_at: Option<DateTime<Utc>>,
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

/// Where an order has got to, as the supplier sees it.
pub enum ActivationState {
    /// Bought, no SMS yet.
    Pending,
    Received {
        code: String,
        text: String,
        /// Everything the number received, newest last. A number is live for
        /// twenty minutes and can take several messages in that window; the
        /// order settles on the first, and the rest still belong to the buyer.
        messages: Vec<Sms>,
    },
    /// Cancelled, timed out, or banned — all of which mean no code is coming.
    Finished,
}

#[derive(Clone)]
pub enum AnyNumberProvider {
    FiveSim(FiveSimProvider),
    /// Development only.
    Stub(StubProvider),
    #[cfg(test)]
    CountingStub(CountingStubProvider),
}

impl AnyNumberProvider {
    pub async fn buy(&self, country: &str, product: &str) -> ApiResult<Activation> {
        match self {
            AnyNumberProvider::FiveSim(p) => p.buy(country, product).await,
            AnyNumberProvider::Stub(p) => p.buy(country, product).await,
            #[cfg(test)]
            AnyNumberProvider::CountingStub(p) => p.buy(country, product).await,
        }
    }

    pub async fn check(&self, order_id: &str) -> ApiResult<ActivationState> {
        match self {
            AnyNumberProvider::FiveSim(p) => p.check(order_id).await,
            AnyNumberProvider::Stub(p) => p.check(order_id).await,
            #[cfg(test)]
            AnyNumberProvider::CountingStub(_) => Ok(ActivationState::Pending),
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
        }
    }

    pub fn is_live(&self) -> bool {
        matches!(self, AnyNumberProvider::FiveSim(_))
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

    async fn buy(&self, country: &str, product: &str) -> ApiResult<Activation> {
        let url = format!("{FIVESIM_BASE}/buy/activation/{country}/{ANY_OPERATOR}/{product}");

        let response = self
            .http
            .get(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, %country, %product, "5sim buy failed");
                ApiError::ServiceUnavailable(
                    "We couldn't reach our number provider. Nothing was charged.".into(),
                )
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(%status, %body, %country, %product, "5sim buy rejected");

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
            return Err(ApiError::ServiceUnavailable(message.into()));
        }

        let order: FiveSimOrder = response.json().await.map_err(|e| {
            tracing::warn!(error = %e, "5sim buy returned unreadable body");
            ApiError::ServiceUnavailable("We couldn't get a number just now.".into())
        })?;

        Ok(Activation {
            provider_order_id: order.id.to_string(),
            phone: order.phone,
            cost: order.price,
            cost_currency: self.currency.clone(),
            expires_at: order.expires,
        })
    }

    async fn check(&self, order_id: &str) -> ApiResult<ActivationState> {
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

        // The SMS list is authoritative over status: a code that arrived is a
        // code we owe the user, whatever the order's label says.
        if !order.sms.is_empty() {
            let messages: Vec<Sms> = order
                .sms
                .into_iter()
                .map(|sms| Sms {
                    sender: sms.sender,
                    text: sms.text,
                    code: sms.code,
                    received_at: sms.date,
                })
                .collect();

            // The order settles on the first message, which is the one the buyer
            // was waiting for. `messages` carries the rest.
            let first = &messages[0];
            return Ok(ActivationState::Received {
                code: first.code.clone().unwrap_or_else(|| first.text.clone()),
                text: first.text.clone(),
                messages,
            });
        }

        match order.status.as_str() {
            "PENDING" | "RECEIVED" => Ok(ActivationState::Pending),
            // CANCELED, TIMEOUT, BANNED, FINISHED — no code is coming.
            _ => Ok(ActivationState::Finished),
        }
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

    async fn buy(&self, country: &str, product: &str) -> ApiResult<Activation> {
        self.buy_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        StubProvider.buy(country, product).await
    }
}

impl StubProvider {
    async fn buy(&self, country: &str, product: &str) -> ApiResult<Activation> {
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

    async fn check(&self, _order_id: &str) -> ApiResult<ActivationState> {
        Ok(ActivationState::Received {
            code: "123456".into(),
            text: "Your code is 123456".into(),
            messages: vec![Sms {
                sender: Some("Naivolt".into()),
                text: "Your code is 123456".into(),
                code: Some("123456".into()),
                received_at: None,
            }],
        })
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
        assert!(AnyNumberProvider::FiveSim(FiveSimProvider::new(
            "key".into(),
            Some("USD".into())
        ))
        .is_live());
        assert!(!AnyNumberProvider::Stub(StubProvider).is_live());
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
}
