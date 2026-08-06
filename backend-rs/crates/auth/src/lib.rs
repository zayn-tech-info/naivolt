//! Authentication: phone and email OTP, sessions, PIN, KYC tiers.
//!
//! Signup is deliberately frictionless — see `docs/ARCHITECTURE.md` §10. One
//! field takes a phone number or an email, the code arrives by SMS or mail, and
//! there is no password anywhere in the system.
//!
//! There is no OAuth. An earlier revision verified Google and Apple ID tokens
//! (`oidc.rs`, removed — recoverable from git history); dropping it removed the
//! per-platform client-id configuration and the Sign in with Apple obligation,
//! which only binds apps that offer a third-party social login.
//!
//! KYC is not part of signup. It is enforced at withdrawal by [`tier`].

#![forbid(unsafe_code)]

pub mod identifier;
pub mod identity;
pub mod otp;
pub mod pin;
pub mod session;
pub mod tier;

pub use identifier::{parse_identifier, Channel, Identifier, IdentifierError};
pub use identity::{ExistingMatches, IdentityClaim, Provider, Resolution};
pub use otp::{OtpChallenge, OtpError};
pub use pin::{hash_pin, verify_pin, PinError};
pub use session::{AccessClaims, SessionError, SessionKeys};
pub use tier::{check_payout, KycTier, PayoutCheck};

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error(transparent)]
    Identifier(#[from] IdentifierError),
    #[error(transparent)]
    Otp(#[from] OtpError),
    #[error(transparent)]
    Pin(#[from] PinError),
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error("identity conflict: {0}")]
    IdentityConflict(String),
}
