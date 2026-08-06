//! Sessions: short-lived access JWTs and rotating refresh tokens.
//!
//! # Why two tokens
//!
//! The access token is a bearer credential sent on every request, so it is
//! deliberately short-lived (15 minutes) — a leaked one expires before it is
//! much use. The refresh token is long-lived but used rarely, travels only to
//! one endpoint, and **rotates on every use**.
//!
//! # Reuse detection
//!
//! Rotation is what makes theft detectable. Each refresh token may be exchanged
//! exactly once; presenting one that has already been rotated means two parties
//! hold it, which means it was stolen. The response is to revoke the entire
//! family — every descendant of that login — rather than the single token,
//! because we cannot tell whether the legitimate user or the thief presented it.

use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Access tokens are minted often and checked on every request.
pub const ACCESS_TTL_MINUTES: i64 = 15;
/// Refresh tokens outlive the app being backgrounded for weeks.
pub const REFRESH_TTL_DAYS: i64 = 30;

const ISSUER: &str = "naivolt";

/// Claims carried in the access token.
///
/// Deliberately minimal: a user id, the KYC tier, and the standard registered
/// claims. Nothing here is secret — a JWT is signed, not encrypted, and anyone
/// holding one can read its payload — so no phone number, email or name.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccessClaims {
    /// User id.
    pub sub: Uuid,
    /// Session family, so a token can be traced to the login that issued it.
    pub sid: Uuid,
    /// KYC tier at issue time. Advisory only — anything that gates on tier
    /// re-reads it from the database, since a token minted before a tier change
    /// stays valid for up to 15 minutes.
    pub tier: i16,
    pub iss: String,
    pub iat: i64,
    pub exp: i64,
}

/// Signing keys. HS256 keeps deployment simple; the key never leaves the server.
pub struct SessionKeys {
    encoding: EncodingKey,
    decoding: DecodingKey,
}

impl SessionKeys {
    /// Build from the configured secret.
    ///
    /// Rejects anything under 32 bytes: HS256's security rests entirely on the
    /// secret's entropy, and a short one is brute-forceable offline by anyone
    /// holding a single token.
    pub fn from_secret(secret: &[u8]) -> Result<Self, SessionError> {
        if secret.len() < 32 {
            return Err(SessionError::WeakSecret(secret.len()));
        }
        Ok(Self {
            encoding: EncodingKey::from_secret(secret),
            decoding: DecodingKey::from_secret(secret),
        })
    }

    pub fn issue_access(
        &self,
        user_id: Uuid,
        session_id: Uuid,
        tier: i16,
        now: DateTime<Utc>,
    ) -> Result<String, SessionError> {
        let claims = AccessClaims {
            sub: user_id,
            sid: session_id,
            tier,
            iss: ISSUER.to_owned(),
            iat: now.timestamp(),
            exp: (now + Duration::minutes(ACCESS_TTL_MINUTES)).timestamp(),
        };
        encode(&Header::new(Algorithm::HS256), &claims, &self.encoding)
            .map_err(|e| SessionError::Encode(e.to_string()))
    }

    /// Verify an access token. Signature, issuer and expiry are all checked;
    /// skipping any one of them makes the token forgeable.
    pub fn verify_access(&self, token: &str) -> Result<AccessClaims, SessionError> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&[ISSUER]);
        validation.validate_exp = true;
        // Tolerate small clock differences between API instances.
        validation.leeway = 30;

        decode::<AccessClaims>(token, &self.decoding, &validation)
            .map(|data| data.claims)
            .map_err(|e| SessionError::Invalid(e.to_string()))
    }
}

/// A freshly minted refresh token: the secret to hand out, and the hash to store.
pub struct RefreshToken {
    /// Returned to the client exactly once. Never persisted.
    pub secret: String,
    /// What goes in the database.
    pub hash: String,
    pub family_id: Uuid,
    pub expires_at: DateTime<Utc>,
}

/// Mint a refresh token.
///
/// `family_id` is `None` for a fresh login and `Some(existing)` when rotating,
/// so every token descended from one login shares an id and the whole line can
/// be revoked together.
pub fn issue_refresh(family_id: Option<Uuid>, now: DateTime<Utc>) -> RefreshToken {
    // 32 bytes from the OS CSPRNG. This is the entire secret — it is not derived
    // from anything guessable like the user id or a timestamp.
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS entropy unavailable");
    let secret = hex::encode(bytes);

    RefreshToken {
        hash: hash_refresh(&secret),
        secret,
        family_id: family_id.unwrap_or_else(Uuid::new_v4),
        expires_at: now + Duration::days(REFRESH_TTL_DAYS),
    }
}

/// Hash a refresh token for storage and lookup.
///
/// Plain SHA-256, not Argon2, and that is deliberate: this is a 256-bit random
/// secret, not a human-chosen password, so there is no dictionary to attack and
/// no need for a slow KDF. Lookup happens on every refresh and must stay fast.
pub fn hash_refresh(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// The stored side of a refresh token, as loaded from `sessions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSession {
    pub id: Uuid,
    pub user_id: Uuid,
    pub family_id: Uuid,
    pub expires_at: DateTime<Utc>,
    /// Set once this token has been exchanged. A second exchange is theft.
    pub rotated_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

/// What the caller must do with a presented refresh token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshOutcome {
    /// Valid and unused. Rotate it and issue a new pair.
    Rotate { user_id: Uuid, family_id: Uuid },
    /// Already rotated — two parties hold this token. Revoke the whole family
    /// and force a fresh login.
    ReuseDetected { family_id: Uuid },
    /// Revoked or expired. Reject, but this is not evidence of theft.
    Rejected,
}

/// Decide what a presented refresh token means.
///
/// Pure, so the security-critical ordering is testable without a database. Note
/// that reuse is checked **before** expiry: a stolen token replayed after it
/// expired is still evidence of compromise, and treating it as a plain rejection
/// would let the theft go unnoticed.
pub fn evaluate_refresh(session: &StoredSession, now: DateTime<Utc>) -> RefreshOutcome {
    if session.rotated_at.is_some() {
        return RefreshOutcome::ReuseDetected {
            family_id: session.family_id,
        };
    }
    if session.revoked_at.is_some() || now >= session.expires_at {
        return RefreshOutcome::Rejected;
    }
    RefreshOutcome::Rotate {
        user_id: session.user_id,
        family_id: session.family_id,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("signing secret is {0} bytes; at least 32 are required")]
    WeakSecret(usize),
    #[error("could not sign token: {0}")]
    Encode(String),
    #[error("token rejected: {0}")]
    Invalid(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"a-test-secret-that-is-long-enough-32";

    fn keys() -> SessionKeys {
        SessionKeys::from_secret(SECRET).unwrap()
    }

    /// Fixed instant for the pure functions, which take `now` as a parameter and
    /// never consult the system clock.
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    /// Real current time, for anything that goes through [`SessionKeys::verify_access`].
    ///
    /// `jsonwebtoken` validates `exp` against the system clock, so a token issued
    /// at the fixed instant above is always expired by the time it is checked.
    /// Tests asserting a *signature* failure must issue at real time, or they
    /// pass because the token expired and never exercise the signature at all.
    fn real_now() -> DateTime<Utc> {
        Utc::now()
    }

    fn session() -> StoredSession {
        StoredSession {
            id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            family_id: Uuid::new_v4(),
            expires_at: now() + Duration::days(30),
            rotated_at: None,
            revoked_at: None,
        }
    }

    #[test]
    fn access_token_round_trips() {
        let user = Uuid::new_v4();
        let sid = Uuid::new_v4();
        let token = keys().issue_access(user, sid, 1, real_now()).unwrap();

        let claims = keys().verify_access(&token).unwrap();
        assert_eq!(claims.sub, user);
        assert_eq!(claims.sid, sid);
        assert_eq!(claims.tier, 1);
    }

    #[test]
    fn short_secrets_are_refused() {
        assert!(matches!(
            SessionKeys::from_secret(b"too-short"),
            Err(SessionError::WeakSecret(9))
        ));
    }

    #[test]
    fn a_token_signed_with_another_secret_is_rejected() {
        let other = SessionKeys::from_secret(b"a-different-secret-also-32-bytes!").unwrap();
        let token = other
            .issue_access(Uuid::new_v4(), Uuid::new_v4(), 0, real_now())
            .unwrap();
        // Unexpired, so the only possible reason to reject it is the signature.
        assert!(keys().verify_access(&token).is_err());
    }

    #[test]
    fn expired_access_tokens_are_rejected() {
        let stale = real_now() - Duration::hours(2);
        let token = keys().issue_access(Uuid::new_v4(), Uuid::new_v4(), 0, stale).unwrap();
        assert!(keys().verify_access(&token).is_err());
    }

    #[test]
    fn tampering_with_the_payload_invalidates_the_signature() {
        let token = keys()
            .issue_access(Uuid::new_v4(), Uuid::new_v4(), 0, real_now())
            .unwrap();
        // Flip a character in the payload segment.
        let mut parts: Vec<&str> = token.split('.').collect();
        let payload = parts[1].to_string();
        let swapped = format!("{}X{}", &payload[..payload.len() - 1], "");
        parts[1] = &swapped;
        assert!(keys().verify_access(&parts.join(".")).is_err());
    }

    #[test]
    fn refresh_secrets_are_unpredictable_and_not_stored_raw() {
        let a = issue_refresh(None, now());
        let b = issue_refresh(None, now());
        assert_ne!(a.secret, b.secret);
        assert_eq!(a.secret.len(), 64); // 32 bytes hex
        // The stored value must not contain the secret.
        assert_ne!(a.hash, a.secret);
        assert_eq!(a.hash, hash_refresh(&a.secret));
    }

    #[test]
    fn rotation_keeps_the_family_and_a_new_login_starts_one() {
        let family = Uuid::new_v4();
        assert_eq!(issue_refresh(Some(family), now()).family_id, family);
        assert_ne!(issue_refresh(None, now()).family_id, family);
    }

    #[test]
    fn a_fresh_token_rotates() {
        let s = session();
        assert_eq!(
            evaluate_refresh(&s, now()),
            RefreshOutcome::Rotate {
                user_id: s.user_id,
                family_id: s.family_id
            }
        );
    }

    /// The property the whole scheme exists for.
    #[test]
    fn presenting_an_already_rotated_token_is_theft_not_a_rejection() {
        let mut s = session();
        s.rotated_at = Some(now() - Duration::minutes(5));
        assert_eq!(
            evaluate_refresh(&s, now()),
            RefreshOutcome::ReuseDetected {
                family_id: s.family_id
            }
        );
    }

    #[test]
    fn reuse_is_detected_even_after_expiry() {
        // A stolen token replayed late is still evidence of compromise. If expiry
        // were checked first this would read as an ordinary rejection and the
        // breach would go unnoticed.
        let mut s = session();
        s.rotated_at = Some(now());
        s.expires_at = now() - Duration::days(1);
        assert!(matches!(
            evaluate_refresh(&s, now()),
            RefreshOutcome::ReuseDetected { .. }
        ));
    }

    #[test]
    fn revoked_and_expired_tokens_are_plainly_rejected() {
        let mut revoked = session();
        revoked.revoked_at = Some(now());
        assert_eq!(evaluate_refresh(&revoked, now()), RefreshOutcome::Rejected);

        let mut expired = session();
        expired.expires_at = now() - Duration::seconds(1);
        assert_eq!(evaluate_refresh(&expired, now()), RefreshOutcome::Rejected);
    }

    #[test]
    fn a_token_expiring_exactly_now_is_rejected() {
        let mut s = session();
        s.expires_at = now();
        assert_eq!(evaluate_refresh(&s, now()), RefreshOutcome::Rejected);
    }
}
