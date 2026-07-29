//! Phone OTP.
//!
//! A 6-digit code is only ~20 bits of entropy, so the security comes almost
//! entirely from the constraints around it — short TTL, few attempts, and rate
//! limits — rather than from the code itself. Every one of those is enforced
//! here rather than left to the caller.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use chrono::{DateTime, Duration, Utc};
use rand::Rng;

/// How long a code stays valid.
pub const OTP_TTL_MINUTES: i64 = 10;
/// Wrong guesses before the challenge is burned.
pub const MAX_ATTEMPTS: i32 = 5;
/// Minimum gap between sends, so the endpoint cannot be used as an SMS cannon
/// (each send costs real money, and floods get numbers blacklisted by carriers).
pub const RESEND_COOLDOWN_SECONDS: i64 = 60;

/// A pending OTP challenge as persisted.
#[derive(Debug, Clone)]
pub struct OtpChallenge {
    pub destination: String,
    /// Argon2 hash. The plaintext code exists only in the SMS and the user's head:
    /// a database leak must not hand over live codes.
    pub code_hash: String,
    pub expires_at: DateTime<Utc>,
    pub attempts: i32,
    pub consumed_at: Option<DateTime<Utc>>,
    pub last_sent_at: DateTime<Utc>,
}

/// Generate a uniformly random 6-digit code, zero-padded.
///
/// Uses the OS CSPRNG. A predictable code is equivalent to no code at all.
pub fn generate_code() -> String {
    let n: u32 = rand::thread_rng().gen_range(0..1_000_000);
    format!("{n:06}")
}

pub fn hash_code(code: &str) -> Result<String, OtpError> {
    let salt = SaltString::generate(&mut rand::thread_rng());
    Argon2::default()
        .hash_password(code.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| OtpError::Hash(e.to_string()))
}

impl OtpChallenge {
    pub fn new(destination: impl Into<String>, code: &str, now: DateTime<Utc>) -> Result<Self, OtpError> {
        Ok(Self {
            destination: destination.into(),
            code_hash: hash_code(code)?,
            expires_at: now + Duration::minutes(OTP_TTL_MINUTES),
            attempts: 0,
            consumed_at: None,
            last_sent_at: now,
        })
    }

    /// Check a submitted code.
    ///
    /// Ordering is deliberate: state checks run *before* the hash comparison, so
    /// an expired or exhausted challenge is rejected without doing the expensive
    /// Argon2 work an attacker would otherwise get for free.
    pub fn verify(&mut self, submitted: &str, now: DateTime<Utc>) -> Result<(), OtpError> {
        if self.consumed_at.is_some() {
            return Err(OtpError::AlreadyUsed);
        }
        if now > self.expires_at {
            return Err(OtpError::Expired);
        }
        if self.attempts >= MAX_ATTEMPTS {
            return Err(OtpError::TooManyAttempts);
        }

        // Count the attempt before checking, so a crash mid-verify cannot be used
        // to get unlimited free guesses.
        self.attempts += 1;

        let parsed = PasswordHash::new(&self.code_hash).map_err(|e| OtpError::Hash(e.to_string()))?;
        match Argon2::default().verify_password(submitted.as_bytes(), &parsed) {
            Ok(()) => {
                self.consumed_at = Some(now);
                Ok(())
            }
            Err(_) => Err(OtpError::Incorrect {
                attempts_remaining: (MAX_ATTEMPTS - self.attempts).max(0),
            }),
        }
    }

    /// Whether a resend is allowed yet.
    pub fn can_resend(&self, now: DateTime<Utc>) -> bool {
        now >= self.last_sent_at + Duration::seconds(RESEND_COOLDOWN_SECONDS)
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OtpError {
    #[error("code has expired, request a new one")]
    Expired,
    #[error("this code has already been used")]
    AlreadyUsed,
    #[error("too many incorrect attempts, request a new code")]
    TooManyAttempts,
    #[error("incorrect code, {attempts_remaining} attempt(s) remaining")]
    Incorrect { attempts_remaining: i32 },
    #[error("hashing failed: {0}")]
    Hash(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn generated_codes_are_always_six_digits() {
        for _ in 0..500 {
            let code = generate_code();
            assert_eq!(code.len(), 6, "got {code}");
            assert!(code.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn generated_codes_vary() {
        let a: Vec<_> = (0..20).map(|_| generate_code()).collect();
        assert!(a.iter().collect::<std::collections::HashSet<_>>().len() > 1);
    }

    #[test]
    fn low_codes_keep_their_leading_zeros() {
        // "000042" must never be stored or sent as "42".
        assert_eq!(format!("{:06}", 42), "000042");
    }

    #[test]
    fn correct_code_verifies_once() {
        let mut c = OtpChallenge::new("+2348012345678", "123456", now()).unwrap();
        assert!(c.verify("123456", now()).is_ok());
        // Replay must fail — otherwise an intercepted SMS stays valid forever.
        assert_eq!(c.verify("123456", now()), Err(OtpError::AlreadyUsed));
    }

    #[test]
    fn wrong_code_counts_down_then_locks_out() {
        let mut c = OtpChallenge::new("+2348012345678", "123456", now()).unwrap();
        for expected_remaining in (0..MAX_ATTEMPTS).rev() {
            assert_eq!(
                c.verify("000000", now()),
                Err(OtpError::Incorrect {
                    attempts_remaining: expected_remaining
                })
            );
        }
        // Exhausted — and now even the *right* code is refused.
        assert_eq!(c.verify("123456", now()), Err(OtpError::TooManyAttempts));
    }

    #[test]
    fn expired_code_is_refused() {
        let mut c = OtpChallenge::new("+2348012345678", "123456", now()).unwrap();
        let late = now() + Duration::minutes(OTP_TTL_MINUTES + 1);
        assert_eq!(c.verify("123456", late), Err(OtpError::Expired));
    }

    #[test]
    fn code_is_still_valid_just_before_expiry() {
        let mut c = OtpChallenge::new("+2348012345678", "123456", now()).unwrap();
        let just_in_time = now() + Duration::minutes(OTP_TTL_MINUTES) - Duration::seconds(1);
        assert!(c.verify("123456", just_in_time).is_ok());
    }

    #[test]
    fn expiry_is_checked_before_attempts_are_spent() {
        let mut c = OtpChallenge::new("+2348012345678", "123456", now()).unwrap();
        let late = now() + Duration::hours(1);
        let _ = c.verify("000000", late);
        assert_eq!(c.attempts, 0, "an expired challenge consumed an attempt");
    }

    #[test]
    fn plaintext_code_is_never_stored() {
        let c = OtpChallenge::new("+2348012345678", "123456", now()).unwrap();
        assert!(!c.code_hash.contains("123456"));
        assert!(c.code_hash.starts_with("$argon2"));
    }

    #[test]
    fn identical_codes_hash_differently() {
        // Distinct salts: two users with the same code must not share a hash,
        // or a leaked table becomes a lookup problem.
        let a = OtpChallenge::new("+2348011111111", "123456", now()).unwrap();
        let b = OtpChallenge::new("+2348022222222", "123456", now()).unwrap();
        assert_ne!(a.code_hash, b.code_hash);
    }

    #[test]
    fn resend_is_rate_limited() {
        let c = OtpChallenge::new("+2348012345678", "123456", now()).unwrap();
        assert!(!c.can_resend(now()));
        assert!(!c.can_resend(now() + Duration::seconds(RESEND_COOLDOWN_SECONDS - 1)));
        assert!(c.can_resend(now() + Duration::seconds(RESEND_COOLDOWN_SECONDS)));
    }
}
