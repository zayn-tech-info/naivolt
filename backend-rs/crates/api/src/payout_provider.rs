//! The payout provider — name enquiry and bank transfers.
//!
//! Paystack in production; a deterministic stub anywhere without a key, so the
//! withdraw flow is exercisable on a laptop. The stub is refused in production by
//! `Config::validate_for_environment`: an app that *appears* to verify account
//! names while inventing them is worse than one that cannot verify at all, and a
//! stub that silently reached production would confirm every account number a
//! user typed.
//!
//! ARCHITECTURE.md §14 notes Paystack's terms restrict crypto-related
//! processing, and that a provider closing the account mid-operation strands
//! customer funds. That is why this is a trait rather than direct calls: adding
//! Flutterwave or Anchor is a new impl, not a rewrite of the payout path.

use crate::error::{ApiError, ApiResult};
use serde::Deserialize;
use std::time::Duration;

#[derive(Clone)]
pub enum AnyPayoutProvider {
    Paystack(PaystackProvider),
    /// Development only.
    Stub(StubProvider),
}

impl AnyPayoutProvider {
    /// Returns the account holder's real name, or a user-safe error.
    pub async fn resolve_account(&self, bank_code: &str, account_number: &str) -> ApiResult<String> {
        match self {
            AnyPayoutProvider::Paystack(p) => p.resolve_account(bank_code, account_number).await,
            AnyPayoutProvider::Stub(p) => p.resolve_account(bank_code, account_number).await,
        }
    }

    /// Whether real transfers can be made. The stub cannot move money, so the
    /// payout path records the reservation and stops rather than pretending.
    pub fn can_transfer(&self) -> bool {
        matches!(self, AnyPayoutProvider::Paystack(_))
    }
}

// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct PaystackProvider {
    http: reqwest::Client,
    secret_key: String,
}

#[derive(Deserialize)]
struct PaystackEnvelope<T> {
    status: bool,
    message: Option<String>,
    data: Option<T>,
}

#[derive(Deserialize)]
struct PaystackAccount {
    account_name: String,
}

impl PaystackProvider {
    pub fn new(secret_key: String) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
            secret_key,
        }
    }

    async fn resolve_account(&self, bank_code: &str, account_number: &str) -> ApiResult<String> {
        let response = self
            .http
            .get("https://api.paystack.co/bank/resolve")
            .bearer_auth(&self.secret_key)
            .query(&[
                ("account_number", account_number),
                ("bank_code", bank_code),
            ])
            .send()
            .await
            .map_err(|e| {
                // Distinguish "we could not ask" from "the bank said no". The
                // first is retryable and not the user's fault; telling them the
                // account is invalid would send them hunting a correct number.
                tracing::warn!(error = %e, "paystack resolve failed");
                ApiError::ServiceUnavailable(
                    "We couldn't reach your bank to check that account. Try again.".into(),
                )
            })?;

        let envelope: PaystackEnvelope<PaystackAccount> = response.json().await.map_err(|e| {
            tracing::warn!(error = %e, "paystack resolve returned unreadable body");
            ApiError::ServiceUnavailable(
                "We couldn't reach your bank to check that account. Try again.".into(),
            )
        })?;

        match (envelope.status, envelope.data) {
            (true, Some(account)) => Ok(account.account_name),
            _ => Err(ApiError::BadRequest(
                envelope
                    .message
                    .unwrap_or_else(|| "Couldn't find that account. Check the number and bank.".into()),
            )),
        }
    }
}

// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct StubProvider;

impl StubProvider {
    async fn resolve_account(&self, _bank_code: &str, account_number: &str) -> ApiResult<String> {
        // Deterministic, so the same number always resolves to the same person
        // and a developer can rely on it across restarts.
        const NAMES: &[&str] = &[
            "ADEYEMI DIVINE",
            "CHINEDU OKAFOR",
            "FATIMA ABUBAKAR",
            "OLUWASEUN ADEBAYO",
            "NGOZI ELUEMUNOR",
            "IBRAHIM MUSA",
            "BLESSING OGUNDIPE",
            "TUNDE BAKARE",
        ];

        // A number ending in 0 fails enquiry, so the not-found path — the error
        // a real user hits from a typo — is reachable without a Paystack key.
        if account_number.ends_with('0') {
            return Err(ApiError::BadRequest(
                "Couldn't find that account. Check the number and bank.".into(),
            ));
        }

        let sum: u32 = account_number
            .chars()
            .filter_map(|c| c.to_digit(10))
            .sum();

        Ok(NAMES[sum as usize % NAMES.len()].to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_stub_is_deterministic() {
        let stub = StubProvider;
        let first = stub.resolve_account("058", "0123454821").await.unwrap();
        let second = stub.resolve_account("058", "0123454821").await.unwrap();
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn the_stub_can_fail_so_the_error_path_is_reachable() {
        let stub = StubProvider;
        assert!(stub.resolve_account("058", "0123454820").await.is_err());
    }

    #[test]
    fn only_a_real_provider_claims_it_can_transfer() {
        assert!(!AnyPayoutProvider::Stub(StubProvider).can_transfer());
        assert!(
            AnyPayoutProvider::Paystack(PaystackProvider::new("sk_test".into())).can_transfer()
        );
    }
}
