//! Authentication: Google/Apple OIDC, phone OTP, PIN, sessions, KYC tiers.
//!
//! Signup is deliberately frictionless — see `docs/ARCHITECTURE.md` §10. KYC is
//! not part of it; it is enforced at withdrawal time by [`tier`].

#![forbid(unsafe_code)]

pub mod identity;
pub mod oidc;
pub mod otp;
pub mod pin;
pub mod tier;

pub use identity::{IdentityClaim, Provider, Resolution};
pub use oidc::{OidcClaims, OidcError};
pub use otp::{OtpChallenge, OtpError};
pub use pin::{hash_pin, verify_pin, PinError};
pub use tier::KycTier;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error(transparent)]
    Oidc(#[from] OidcError),
    #[error(transparent)]
    Otp(#[from] OtpError),
    #[error(transparent)]
    Pin(#[from] PinError),
    #[error("identity conflict: {0}")]
    IdentityConflict(String),
}
