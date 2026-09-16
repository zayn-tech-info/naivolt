//! Shared application state.

use crate::funding_provider::AnyFundingProvider;
use crate::google_keys::GoogleKeys;
use crate::notify::AnyNotifier;
use crate::number_provider::NumberProviders;
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
    pub numbers: Arc<NumberProviders>,
    pub funding: Arc<AnyFundingProvider>,
    /// Google's signing keys, fetched once and refreshed on rotation.
    pub google_keys: Arc<GoogleKeys>,
    /// The OAuth client id incoming ID tokens must be addressed to. None when
    /// Google sign-in is not configured, which the route reports as such rather
    /// than accepting tokens minted for some other app.
    pub google_client_id: Option<String>,
    /// Development only: when set, every OTP challenge uses this code instead of
    /// a random one. Guaranteed None in production by Config validation.
    pub dev_otp_code: Option<String>,
    /// Development only: approve KYC on submission. False in production.
    pub auto_approve_kyc: bool,
    /// Who may sign in with Google. Empty means anyone.
    pub google_allowed_emails: Arc<Vec<String>>,
    /// Shared secret for the read-only admin endpoints; None disables them.
    pub admin_token: Option<String>,
    pub operations_alert_email: Option<String>,
    pub operator_totp_key: Option<Vec<u8>>,
    pub admin_refund_cap_ngn: rust_decimal::Decimal,
    /// Hide a number unless it costs at least this fraction of the dearest
    /// option for the same app and country. See `Config`.
    pub numbers_min_price_fraction: rust_decimal::Decimal,
    pub totp_lockouts: Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<std::time::Instant>>>>,
    /// Where the dashboard lives, without a trailing slash. Paystack returns the
    /// payer to a URL under it.
    pub web_app_url: String,
}
