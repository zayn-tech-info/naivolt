//! Authentication: phone and email OTP, sessions, PIN, KYC tiers.
//!
//! Signup is deliberately frictionless — see `docs/ARCHITECTURE.md` §10. One
//! field takes a phone number or an email, the code arrives by SMS or mail, and
//! there is no password anywhere in the system.
//!
//! Google sign-in is verified in [`oidc`] and offered on the website only.
//! Apple's Sign in with Apple requirement binds apps that offer a third-party
//! social login, not websites, so the Expo app stays OTP-only until Apple's
//! button ships alongside.
//!
//! KYC is not part of signup. It is enforced at withdrawal by [`tier`].

#![forbid(unsafe_code)]

pub mod identifier;
pub mod identity;
pub mod oidc;
pub mod otp;
pub mod pin;
pub mod session;
pub mod tier;

pub use identifier::{parse_identifier, Channel, Identifier, IdentifierError};
pub use identity::{ExistingMatches, IdentityClaim, Provider, Resolution};
pub use oidc::{key_id, verify_id_token, OidcConfig, OidcError};
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
