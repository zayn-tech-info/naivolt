//! Transaction PIN.
//!
//! The PIN is not a login credential — sessions handle that. It is the
//! confirmation step in front of moving money, so its job is to make a stolen
//! *unlocked phone* insufficient to drain an account.
//!
//! Six digits is a million possibilities, which is only meaningful with Argon2id
//! at rest and server-side attempt limiting on top.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};

pub const PIN_LENGTH: usize = 6;
/// Wrong PINs before withdrawals lock and re-auth is required.
pub const MAX_PIN_ATTEMPTS: i32 = 5;

/// Argon2id tuned for an interactive check: ~19 MiB, 2 passes.
/// Strong enough to make offline cracking of a 6-digit space expensive, fast
/// enough that a user does not notice.
fn argon2() -> Argon2<'static> {
    let params = Params::new(19 * 1024, 2, 1, None).expect("static argon2 params are valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

pub fn hash_pin(pin: &str) -> Result<String, PinError> {
    validate_pin_strength(pin)?;
    let salt = SaltString::generate(&mut rand::thread_rng());
    argon2()
        .hash_password(pin.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| PinError::Hash(e.to_string()))
}

pub fn verify_pin(pin: &str, stored_hash: &str) -> Result<bool, PinError> {
    let parsed = PasswordHash::new(stored_hash).map_err(|e| PinError::Hash(e.to_string()))?;
    Ok(argon2().verify_password(pin.as_bytes(), &parsed).is_ok())
}

/// Reject PINs that a shoulder-surfer or a bored attacker would try first.
///
/// The blocked set is small on purpose. Rejecting too much pushes users into
/// writing the PIN down, which is a worse outcome than a slightly weak one.
pub fn validate_pin_strength(pin: &str) -> Result<(), PinError> {
    if pin.len() != PIN_LENGTH || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(PinError::WrongFormat);
    }

    let digits: Vec<u8> = pin.bytes().map(|b| b - b'0').collect();

    // 000000, 111111, …
    if digits.iter().all(|&d| d == digits[0]) {
        return Err(PinError::TooCommon);
    }

    // 123456 and 654321, and any other run of consecutive digits.
    let ascending = digits.windows(2).all(|w| w[1] == w[0] + 1);
    let descending = digits.windows(2).all(|w| w[0] == w[1] + 1);
    if ascending || descending {
        return Err(PinError::TooCommon);
    }

    // Repeated pairs/triples: 121212, 123123.
    if digits[..2] == digits[2..4] && digits[2..4] == digits[4..] {
        return Err(PinError::TooCommon);
    }
    if digits[..3] == digits[3..] {
        return Err(PinError::TooCommon);
    }

    // Years — overwhelmingly common as a birth year prefix or suffix.
    if matches!(&pin[..2], "19" | "20") && pin[2..].chars().all(|c| c.is_ascii_digit()) {
        if let Ok(year) = pin[..4].parse::<u32>() {
            if (1940..=2030).contains(&year) && &pin[4..] == "00" {
                return Err(PinError::TooCommon);
            }
        }
    }

    Ok(())
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PinError {
    #[error("PIN must be exactly 6 digits")]
    WrongFormat,
    #[error("that PIN is too easy to guess, please choose another")]
    TooCommon,
    #[error("hashing failed: {0}")]
    Hash(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let hash = hash_pin("428193").unwrap();
        assert!(verify_pin("428193", &hash).unwrap());
        assert!(!verify_pin("428194", &hash).unwrap());
    }

    #[test]
    fn plaintext_pin_is_never_in_the_hash() {
        let hash = hash_pin("428193").unwrap();
        assert!(!hash.contains("428193"));
        assert!(hash.starts_with("$argon2id$"));
    }

    #[test]
    fn same_pin_hashes_differently_per_user() {
        assert_ne!(hash_pin("428193").unwrap(), hash_pin("428193").unwrap());
    }

    #[test]
    fn rejects_wrong_format() {
        for bad in ["12345", "1234567", "12a456", "", "abcdef", "12 456"] {
            assert_eq!(
                validate_pin_strength(bad),
                Err(PinError::WrongFormat),
                "accepted {bad:?}"
            );
        }
    }

    #[test]
    fn rejects_guessable_pins() {
        for bad in [
            "000000", "111111", "999999", // all same
            "123456", "234567", "456789", // ascending
            "654321", "987654",           // descending
            "121212", "343434",           // repeated pair
            "123123", "456456",           // repeated triple
            "199000", "200500",           // year-shaped
        ] {
            assert_eq!(
                validate_pin_strength(bad),
                Err(PinError::TooCommon),
                "accepted weak PIN {bad}"
            );
        }
    }

    #[test]
    fn accepts_ordinary_pins() {
        for good in ["428193", "704562", "913847", "260194", "581037"] {
            assert!(
                validate_pin_strength(good).is_ok(),
                "rejected reasonable PIN {good}"
            );
        }
    }

    #[test]
    fn weak_pins_cannot_be_hashed_at_all() {
        // Strength is enforced at the hashing boundary, so no caller can skip it.
        assert_eq!(hash_pin("123456"), Err(PinError::TooCommon));
        assert_eq!(hash_pin("12345"), Err(PinError::WrongFormat));
    }

    #[test]
    fn corrupt_stored_hash_errors_rather_than_passing() {
        // A garbled hash must never verify as success.
        assert!(verify_pin("428193", "not-a-hash").is_err());
    }
}
