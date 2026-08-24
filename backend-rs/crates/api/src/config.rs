//! Configuration, read once at boot.
//!
//! Everything is validated up front and the process refuses to start if anything
//! required is missing or weak. A server that boots with a placeholder JWT secret
//! and only fails when the first user signs in is worse than one that never
//! started.

/// The fixed code used in development when DEV_OTP_CODE is unset.
const DEFAULT_DEV_OTP_CODE: &str = "021236";

use anyhow::{bail, Context, Result};
use rust_decimal::Decimal;
use std::env;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    Development,
    Staging,
    Production,
}

impl Environment {
    pub fn is_production(self) -> bool {
        matches!(self, Environment::Production)
    }
}

pub struct Config {
    pub environment: Environment,
    pub bind_addr: String,
    pub database_url: String,
    pub jwt_secret: String,
    /// None in development, where codes are logged instead of sent.
    pub termii_api_key: Option<String>,
    pub termii_sender_id: String,
    pub resend_api_key: Option<String>,
    pub email_from: String,
    /// Base URL of the isolated signer. None means derive in-process, which is
    /// only allowed outside production — see [`Config::load`].
    pub signer_url: Option<String>,
    /// Dev-only: the mnemonic used for in-process derivation.
    pub dev_mnemonic: Option<String>,
    /// Dev-only: approve KYC submissions on the spot, so a local build can
    /// reach a tier that permits withdrawal. Never true in production.
    pub auto_approve_kyc: bool,
    /// Dev-only: a fixed OTP code, so signing in locally does not require
    /// digging the real code out of the server log. Never Some in production —
    /// see `validate_for_environment`.
    pub dev_otp_code: Option<String>,

    /// None outside production, where account resolution falls back to a stub.
    pub paystack_secret_key: Option<String>,
    /// The web OAuth client id. Tokens minted for any other client are valid
    /// Google tokens signed by the same issuer — checking the audience against
    /// this is what stops one being replayed here.
    pub google_client_id: Option<String>,
    /// None outside production, where numbers come from a stub provider.
    pub fivesim_api_key: Option<String>,
    /// The unit 5SIM quotes prices in. Their API returns a bare number and never
    /// names the currency, so it is stated here rather than guessed at — a wrong
    /// guess would put a mislabelled cost on every order.
    pub fivesim_currency: Option<String>,
    /// Where the dashboard lives. Paystack sends the payer back here, so a wrong
    /// value strands someone who has already been charged on a page that cannot
    /// tell them their money arrived.
    pub web_app_url: String,
    /// What a number sells for, as a multiple of what the supplier charges. The
    /// naira price is derived rather than typed, because a hand-set price goes
    /// stale silently: 5SIM moved US WhatsApp to $0.90 while our table still
    /// said ₦1,010, which is a loss on every sale.
    pub numbers_margin: Decimal,
    /// Naira per US dollar before margin. Tracks the parallel market, not the
    /// official rate — see `pricing.rs` for why that distinction matters.
    pub usd_ngn_mid: Decimal,
    /// Our margin, in naira per dollar of value transacted. ~0.65% at a 1530
    /// mid; 20 gives the 1.3% target in ARCHITECTURE.md §9.
    pub spread_ngn_per_usd: Decimal,
}

impl Config {
    pub fn load() -> Result<Self> {
        let environment = match env::var("APP_ENV").as_deref() {
            Ok("production") | Ok("prod") => Environment::Production,
            Ok("staging") => Environment::Staging,
            _ => Environment::Development,
        };

        let jwt_secret = require("JWT_SECRET")?;
        // HS256's entire security is the secret's entropy; a short one is
        // brute-forceable offline by anyone holding a single token.
        if jwt_secret.len() < 32 {
            bail!(
                "JWT_SECRET is {} bytes; at least 32 are required",
                jwt_secret.len()
            );
        }

        // Defaults on in development. A fixed code is a total bypass of the
        // one factor protecting an account, so it is opt-*out* only where no
        // real account can exist, and refused outright in production below.
        let dev_otp_code = match env::var("DEV_OTP_CODE") {
            Ok(raw) if raw.trim().is_empty() => None,
            Ok(raw) => Some(raw.trim().to_owned()),
            Err(_) if matches!(environment, Environment::Development) => {
                Some(DEFAULT_DEV_OTP_CODE.to_owned())
            }
            Err(_) => None,
        };

        if let Some(code) = &dev_otp_code {
            // A code that is not six digits could never be entered, so the
            // fallback would silently be a random one and the setting would look
            // broken rather than ignored.
            if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
                bail!("DEV_OTP_CODE must be exactly 6 digits, got {code:?}");
            }
        }

        // On in development for the same reason as the fixed OTP: without it the
        // whole payout path is untestable locally, because tier 0 cannot withdraw.
        let auto_approve_kyc = match env::var("DEV_AUTO_APPROVE_KYC") {
            Ok(raw) => raw == "true" || raw == "1",
            Err(_) => matches!(environment, Environment::Development),
        };

        let signer_url = env::var("SIGNER_URL").ok().filter(|s| !s.is_empty());
        let dev_mnemonic = env::var("DEV_MNEMONIC").ok().filter(|s| !s.is_empty());

        let config = Self {
            environment,
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:5000".into()),
            database_url: require("DATABASE_URL")?,
            jwt_secret,
            termii_api_key: env::var("TERMII_API_KEY").ok().filter(|s| !s.is_empty()),
            termii_sender_id: env::var("TERMII_SENDER_ID").unwrap_or_else(|_| "Naivolt".into()),
            resend_api_key: env::var("RESEND_API_KEY").ok().filter(|s| !s.is_empty()),
            email_from: env::var("EMAIL_FROM")
                .unwrap_or_else(|_| "Naivolt <no-reply@naivolt.com>".into()),
            signer_url,
            dev_mnemonic,
            dev_otp_code,
            auto_approve_kyc,
            paystack_secret_key: env::var("PAYSTACK_SECRET_KEY").ok().filter(|s| !s.is_empty()),
            google_client_id: env::var("GOOGLE_CLIENT_ID").ok().filter(|s| !s.is_empty()),
            fivesim_api_key: env::var("FIVESIM_API_KEY").ok().filter(|s| !s.is_empty()),
            fivesim_currency: env::var("FIVESIM_CURRENCY").ok().filter(|s| !s.is_empty()),
            web_app_url: env::var("WEB_APP_URL")
                .unwrap_or_else(|_| "http://localhost:5173".into())
                .trim_end_matches('/')
                .to_owned(),
            numbers_margin: decimal_env("NUMBERS_MARGIN", Decimal::new(16, 1))?,
            usd_ngn_mid: decimal_env("USD_NGN_MID", Decimal::from(1530))?,
            spread_ngn_per_usd: decimal_env("SPREAD_NGN_PER_USD", Decimal::from(10))?,
        };

        // A margin at or below 1 sells every number for less than it costs.
        if config.numbers_margin <= Decimal::ONE {
            bail!(
                "NUMBERS_MARGIN is {}; at or below 1 every number sells at a loss",
                config.numbers_margin
            );
        }

        config.validate_for_environment()?;
        Ok(config)
    }

    /// Production has stricter requirements than development, and they are
    /// enforced here rather than trusted to deployment discipline.
    fn validate_for_environment(&self) -> Result<()> {
        if !self.environment.is_production() {
            return Ok(());
        }

        // In production the API must never be able to derive a key itself. If it
        // could, compromising the public HTTP surface would mean losing funds —
        // the isolation in ARCHITECTURE.md §4 exists precisely to prevent that.
        if self.signer_url.is_none() {
            bail!("SIGNER_URL is required in production — the API must not hold key material");
        }
        if self.dev_mnemonic.is_some() {
            bail!("DEV_MNEMONIC must not be set in production");
        }
        // The single most dangerous setting in this file. A fixed code means
        // anyone who knows it owns every account on the platform.
        if self.dev_otp_code.is_some() {
            bail!("DEV_OTP_CODE must not be set in production — it bypasses sign-in entirely");
        }
        // Auto-approval would hand every account a withdrawal limit without any
        // identity check, which is the AML control this tier system exists for.
        if self.auto_approve_kyc {
            bail!("DEV_AUTO_APPROVE_KYC must not be set in production — it skips identity checks");
        }

        // Without these, a user can request a code that is never delivered and
        // has no way to tell — the request looks successful.
        if self.termii_api_key.is_none() {
            bail!("TERMII_API_KEY is required in production to deliver SMS codes");
        }
        if self.resend_api_key.is_none() {
            bail!("RESEND_API_KEY is required in production to deliver email codes");
        }

        // Without this, account resolution falls back to a stub that invents
        // plausible names for any number. In production that would confirm every
        // account a user typed, including the mistyped ones — which is precisely
        // the failure name enquiry exists to prevent.
        if self.paystack_secret_key.is_none() {
            bail!("PAYSTACK_SECRET_KEY is required in production — account names must be verified, not invented");
        }

        // The stub hands out numbers that look plausible and always deliver a
        // code. Reaching production it would sell people numbers that do not
        // exist and charge them for the privilege.
        if self.fivesim_api_key.is_none() {
            bail!("FIVESIM_API_KEY is required in production — the stub provider issues numbers that do not exist");
        }

        // Paystack returns the payer to this URL. Left at its development
        // default, everyone who pays in production lands on a page that only
        // exists on the developer's laptop.
        if self.web_app_url.starts_with("http://localhost")
            || self.web_app_url.starts_with("http://127.")
        {
            bail!(
                "WEB_APP_URL is {} in production — card payers would be returned to a local address",
                self.web_app_url
            );
        }

        Ok(())
    }
}

/// Reads a decimal from the environment, falling back to a default.
///
/// A malformed value is fatal rather than silently defaulted: the difference
/// between a mid rate of 1530 and an unparsed "1,530" is every price the
/// platform quotes, and that must not degrade quietly.
fn decimal_env(key: &str, fallback: Decimal) -> Result<Decimal> {
    match env::var(key) {
        Ok(raw) if !raw.trim().is_empty() => Decimal::from_str(raw.trim())
            .with_context(|| format!("{key} is not a valid decimal: {raw}")),
        _ => Ok(fallback),
    }
}

fn require(key: &str) -> Result<String> {
    env::var(key)
        .with_context(|| format!("{key} is not set"))
        .and_then(|v| {
            if v.trim().is_empty() {
                bail!("{key} is empty")
            } else {
                Ok(v)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A production config with everything required present, so each test can
    /// flip exactly one field and assert on that.
    fn production_config() -> Config {
        Config {
            environment: Environment::Production,
            bind_addr: "0.0.0.0:8000".into(),
            database_url: "postgres://localhost/naivolt".into(),
            jwt_secret: "x".repeat(48),
            termii_api_key: Some("k".into()),
            termii_sender_id: "Naivolt".into(),
            resend_api_key: Some("k".into()),
            email_from: "Naivolt <no-reply@naivolt.com>".into(),
            signer_url: Some("https://signer.internal".into()),
            dev_mnemonic: None,
            dev_otp_code: None,
            auto_approve_kyc: false,
            paystack_secret_key: Some("sk_live".into()),
            google_client_id: Some("naivolt-web.apps.googleusercontent.com".into()),
            fivesim_api_key: Some("5sim_live".into()),
            fivesim_currency: Some("USD".into()),
            web_app_url: "https://naivolt.com".into(),
            numbers_margin: Decimal::new(16, 1),
            usd_ngn_mid: Decimal::from(1530),
            spread_ngn_per_usd: Decimal::from(10),
        }
    }

    #[test]
    fn a_valid_production_config_passes() {
        assert!(production_config().validate_for_environment().is_ok());
    }

    /// Paystack returns the payer to this URL. Left at its development default,
    /// every successful card payment in production lands on a page that exists
    /// only on someone's laptop — money taken, balance apparently unchanged.
    #[test]
    fn production_refuses_to_boot_returning_payers_to_localhost() {
        let mut config = production_config();
        config.web_app_url = "http://localhost:5173".into();
        assert!(config.validate_for_environment().is_err());

        config.web_app_url = "http://127.0.0.1:5173".into();
        assert!(config.validate_for_environment().is_err());
    }

    /// The most important assertion in this file. A fixed OTP means anyone who
    /// knows six digits owns every account, so production must refuse to start
    /// rather than run with it.
    #[test]
    fn production_refuses_to_boot_with_a_fixed_otp_code() {
        let mut config = production_config();
        config.dev_otp_code = Some("021236".into());

        let err = config.validate_for_environment().unwrap_err().to_string();
        assert!(err.contains("DEV_OTP_CODE"), "unexpected error: {err}");
    }

    #[test]
    fn production_refuses_in_process_key_derivation() {
        let mut config = production_config();
        config.dev_mnemonic = Some("test test test".into());
        assert!(config.validate_for_environment().is_err());
    }

    #[test]
    fn production_refuses_a_stubbed_payout_provider() {
        // Without a real provider, account names are invented rather than
        // verified — which would confirm every mistyped number a user entered.
        let mut config = production_config();
        config.paystack_secret_key = None;
        assert!(config.validate_for_environment().is_err());
    }
}
