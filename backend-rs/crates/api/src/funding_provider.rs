//! The funding provider — charging a card to credit a naira balance.
//!
//! Paystack in production; a stub anywhere without a key, so the fund-then-buy
//! flow is walkable on a laptop. `Config::validate_for_environment` already
//! refuses a missing Paystack key in production, which covers this too.
//!
//! One caveat carried over from `payout_provider.rs` and ARCHITECTURE.md §14:
//! Paystack's terms restrict crypto-related processing. Collections are more
//! exposed than payouts — a frozen collections account stops new money entering
//! rather than merely delaying an exit — so this is an enum for the same reason
//! payouts are, and a second provider is a variant rather than a rewrite.

use crate::error::{ApiError, ApiResult};
use rust_decimal::Decimal;
use serde::Deserialize;
use std::time::Duration;

/// What the provider needs from the user to take the money.
pub struct InitializedCharge {
    /// Where to send the user to pay. None for the stub, which takes nothing.
    pub authorization_url: Option<String>,
}

pub enum ChargeState {
    Pending,
    /// The provider confirms the money is theirs to settle. `amount_ngn` is what
    /// they actually took, which is the figure we credit — never the intent.
    Succeeded { amount_ngn: Decimal },
    Failed { reason: String },
}

#[derive(Clone)]
pub enum AnyFundingProvider {
    Paystack(PaystackFunding),
    /// Development only.
    Stub(StubFunding),
}

impl AnyFundingProvider {
    pub async fn initialize(
        &self,
        email: &str,
        amount_ngn: Decimal,
        reference: &str,
        callback_url: &str,
    ) -> ApiResult<InitializedCharge> {
        match self {
            AnyFundingProvider::Paystack(p) => {
                p.initialize(email, amount_ngn, reference, callback_url).await
            }
            AnyFundingProvider::Stub(p) => p.initialize(email, amount_ngn, reference).await,
        }
    }

    pub async fn verify(&self, reference: &str, intent_ngn: Decimal) -> ApiResult<ChargeState> {
        match self {
            AnyFundingProvider::Paystack(p) => p.verify(reference).await,
            AnyFundingProvider::Stub(p) => p.verify(reference, intent_ngn).await,
        }
    }

    /// Whether real cards can be charged. The stub cannot, so anything that
    /// would imply real money moved must check this first.
    pub fn is_live(&self) -> bool {
        matches!(self, AnyFundingProvider::Paystack(_))
    }
}

// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct PaystackFunding {
    http: reqwest::Client,
    secret_key: String,
}

#[derive(Deserialize)]
struct Envelope<T> {
    status: bool,
    // Serde already maps a missing Option field to None. Marking these
    // `#[serde(default)]` would additionally demand `T: Default`, which a
    // response payload has no reason to implement.
    message: Option<String>,
    data: Option<T>,
}

/// Paystack's own field names are snake_case; do not rename them.
#[derive(Deserialize)]
struct InitData {
    authorization_url: String,
}

#[derive(Deserialize)]
struct VerifyData {
    status: String,
    /// Kobo. Paystack speaks only in the currency's minor unit.
    amount: i64,
    gateway_response: Option<String>,
}

impl PaystackFunding {
    pub fn new(secret_key: String) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
            secret_key,
        }
    }

    async fn initialize(
        &self,
        email: &str,
        amount_ngn: Decimal,
        reference: &str,
        callback_url: &str,
    ) -> ApiResult<InitializedCharge> {
        // Kobo, and integral. A fractional kobo is not a thing Paystack can
        // charge, and rounding it here rather than letting them do it keeps the
        // amount we recorded and the amount they take in step.
        let kobo = (amount_ngn * Decimal::from(100)).round().to_string();

        let response = self
            .http
            .post("https://api.paystack.co/transaction/initialize")
            .bearer_auth(&self.secret_key)
            .json(&serde_json::json!({
                "email": email,
                "amount": kobo,
                "reference": reference,
                "currency": "NGN",
                // Sent per transaction rather than left to the dashboard
                // setting: the dashboard's URL is one value for every
                // integration, and this one has to carry the intent id so the
                // page the payer lands on knows which top-up to confirm.
                "callback_url": callback_url,
            }))
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, "paystack initialize failed");
                ApiError::ServiceUnavailable(
                    "We couldn't start that payment. Nothing was charged.".into(),
                )
            })?;

        let envelope: Envelope<InitData> = response.json().await.map_err(|e| {
            tracing::warn!(error = %e, "paystack initialize returned unreadable body");
            ApiError::ServiceUnavailable("We couldn't start that payment.".into())
        })?;

        match (envelope.status, envelope.data) {
            (true, Some(data)) => Ok(InitializedCharge {
                authorization_url: Some(data.authorization_url),
            }),
            _ => {
                tracing::warn!(message = ?envelope.message, "paystack refused initialize");
                Err(ApiError::ServiceUnavailable(
                    "We couldn't start that payment. Nothing was charged.".into(),
                ))
            }
        }
    }

    async fn verify(&self, reference: &str) -> ApiResult<ChargeState> {
        let response = self
            .http
            .get(format!(
                "https://api.paystack.co/transaction/verify/{reference}"
            ))
            .bearer_auth(&self.secret_key)
            .send()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, %reference, "paystack verify failed");
                ApiError::ServiceUnavailable("We couldn't check that payment.".into())
            })?;

        let envelope: Envelope<VerifyData> = response.json().await.map_err(|e| {
            tracing::warn!(error = %e, "paystack verify returned unreadable body");
            ApiError::ServiceUnavailable("We couldn't check that payment.".into())
        })?;

        let Some(data) = envelope.data else {
            return Ok(ChargeState::Pending);
        };

        match data.status.as_str() {
            // Credit what Paystack says it took, not what we asked for. The two
            // differ if the amount was ever edited in flight, and theirs is the
            // one backed by money.
            "success" => Ok(ChargeState::Succeeded {
                amount_ngn: Decimal::from(data.amount) / Decimal::from(100),
            }),
            "failed" | "reversed" => Ok(ChargeState::Failed {
                reason: data
                    .gateway_response
                    .unwrap_or_else(|| "the bank declined that card".into()),
            }),
            _ => Ok(ChargeState::Pending),
        }
    }
}

// ---------------------------------------------------------------------------

/// Development only. Takes no money and confirms instantly, so the
/// fund-then-buy path is walkable without a live card.
#[derive(Clone)]
pub struct StubFunding;

impl StubFunding {
    async fn initialize(
        &self,
        email: &str,
        amount_ngn: Decimal,
        reference: &str,
    ) -> ApiResult<InitializedCharge> {
        tracing::warn!(
            %email, %amount_ngn, %reference,
            "stub funding — no card charged, balance credited on verify"
        );
        // No URL: there is nowhere to send anyone. The client treats a missing
        // url as "already done" rather than showing a broken checkout link.
        Ok(InitializedCharge {
            authorization_url: None,
        })
    }

    async fn verify(&self, _reference: &str, intent_ngn: Decimal) -> ApiResult<ChargeState> {
        Ok(ChargeState::Succeeded {
            amount_ngn: intent_ngn,
        })
    }
}
