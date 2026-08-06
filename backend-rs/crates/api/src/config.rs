//! Configuration, read once at boot.
//!
//! Everything is validated up front and the process refuses to start if anything
//! required is missing or weak. A server that boots with a placeholder JWT secret
//! and only fails when the first user signs in is worse than one that never
//! started.

use anyhow::{bail, Context, Result};
use std::env;

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
        };

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

        // Without these, a user can request a code that is never delivered and
        // has no way to tell — the request looks successful.
        if self.termii_api_key.is_none() {
            bail!("TERMII_API_KEY is required in production to deliver SMS codes");
        }
        if self.resend_api_key.is_none() {
            bail!("RESEND_API_KEY is required in production to deliver email codes");
        }

        Ok(())
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
