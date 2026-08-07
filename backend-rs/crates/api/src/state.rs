//! Shared application state.

use crate::notify::AnyNotifier;
use crate::payout_provider::AnyPayoutProvider;
use crate::pricing::Rates;
use crate::signer::AnyAddressProvider;
use naivolt_auth::session::SessionKeys;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub keys: Arc<SessionKeys>,
    pub notifier: Arc<AnyNotifier>,
    pub addresses: Arc<AnyAddressProvider>,
    pub rates: Rates,
    pub payouts: Arc<AnyPayoutProvider>,
    /// Development only: when set, every OTP challenge uses this code instead of
    /// a random one. Guaranteed None in production by Config validation.
    pub dev_otp_code: Option<String>,
    /// Development only: approve KYC on submission. False in production.
    pub auto_approve_kyc: bool,
}
