//! Parsing the single sign-in field.
//!
//! The app asks for "phone or email" in one input and decides which it got. That
//! decision has to be made identically on both sides — the client picks which
//! keyboard and hint to show, the server picks which channel to send the code
//! over — so the rules live here and `src/services/authV2.ts` mirrors them.
//!
//! Getting the split wrong is not cosmetic: a phone parsed as an email is a code
//! sent to an address that does not exist, and a user who cannot sign in.

use crate::identity::Provider;
use serde::{Deserialize, Serialize};
use std::fmt;

/// A validated sign-in identifier.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum Identifier {
    /// E.164, always `+234…` — see [`normalize_ng_phone`].
    Phone(String),
    /// Lowercased and trimmed.
    Email(String),
}

impl Identifier {
    pub fn provider(&self) -> Provider {
        match self {
            Identifier::Phone(_) => Provider::Phone,
            Identifier::Email(_) => Provider::Email,
        }
    }

    /// The stable subject stored on the identity row.
    pub fn subject(&self) -> &str {
        match self {
            Identifier::Phone(v) | Identifier::Email(v) => v,
        }
    }

    /// How the OTP reaches the user.
    pub fn channel(&self) -> Channel {
        match self {
            Identifier::Phone(_) => Channel::Sms,
            Identifier::Email(_) => Channel::Email,
        }
    }

    /// Partially masked, for "we sent a code to …" without echoing the whole
    /// address back into a screenshot or a support ticket.
    pub fn masked(&self) -> String {
        match self {
            Identifier::Phone(p) => {
                // +2348012345678 -> +234 801 ••• 5678
                if p.len() == 14 {
                    format!("{} {} ••• {}", &p[..4], &p[4..7], &p[10..])
                } else {
                    p.clone()
                }
            }
            Identifier::Email(e) => match e.split_once('@') {
                Some((local, domain)) if local.len() > 2 => {
                    format!("{}{}@{}", &local[..2], "•".repeat(local.len() - 2), domain)
                }
                _ => e.clone(),
            },
        }
    }
}

impl fmt::Display for Identifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.subject())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Sms,
    Email,
}

/// Decide whether the user typed a phone number or an email, and normalise it.
///
/// The discriminator is `@`, checked first and deliberately: a string containing
/// one is never a phone number, and treating "0801@..." as a phone because it
/// starts with digits would send an SMS into the void. Anything without an `@`
/// is attempted as a Nigerian mobile number.
pub fn parse_identifier(input: &str) -> Result<Identifier, IdentifierError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(IdentifierError::Empty);
    }

    if trimmed.contains('@') {
        return normalize_email(trimmed)
            .map(Identifier::Email)
            .ok_or(IdentifierError::InvalidEmail);
    }

    normalize_ng_phone(trimmed)
        .map(Identifier::Phone)
        .ok_or(IdentifierError::InvalidPhone)
}

/// Normalise a Nigerian mobile number to E.164.
///
/// The same person types `08012345678`, `+2348012345678` and `234 801 234 5678`.
/// Storing those as three identities would give one human three accounts and
/// three sets of wallets.
pub fn normalize_ng_phone(input: &str) -> Option<String> {
    let digits: String = input.chars().filter(|c| c.is_ascii_digit()).collect();

    let national = match digits.as_str() {
        d if d.len() == 11 && d.starts_with('0') => &d[1..],
        d if d.len() == 13 && d.starts_with("234") => &d[3..],
        d if d.len() == 10 => d,
        _ => return None,
    };

    // NG mobile prefixes after the trunk zero: 70, 80, 81, 90, 91.
    if !matches!(&national[..1], "7" | "8" | "9") {
        return None;
    }

    Some(format!("+234{national}"))
}

/// Normalise an email for storage and comparison.
///
/// Gmail's dot and plus aliasing is deliberately **not** collapsed. It would be
/// correct for Gmail and wrong for most other providers, and an over-eager
/// normalisation in the linking direction hands one user another's account.
pub fn normalize_email(input: &str) -> Option<String> {
    let value = input.trim().to_ascii_lowercase();

    let (local, domain) = value.split_once('@')?;
    if local.is_empty() || domain.is_empty() {
        return None;
    }
    // Exactly one '@', a dot in the domain, and no whitespace anywhere.
    if domain.contains('@') || !domain.contains('.') || value.split_whitespace().count() != 1 {
        return None;
    }
    // Reject a domain with an empty label: "a@.com", "a@b." , "a@b..c".
    if domain.split('.').any(str::is_empty) {
        return None;
    }

    Some(value)
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IdentifierError {
    #[error("enter your phone number or email")]
    Empty,
    #[error("enter a valid email address")]
    InvalidEmail,
    #[error("enter a valid Nigerian phone number")]
    InvalidPhone,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_ng_phone_format_normalises_to_one_identity() {
        let expected = Identifier::Phone("+2348012345678".into());
        for input in [
            "08012345678",
            "+2348012345678",
            "2348012345678",
            "234 801 234 5678",
            "0801-234-5678",
            "8012345678",
            "  08012345678  ",
        ] {
            assert_eq!(parse_identifier(input).unwrap(), expected, "failed on {input}");
        }
    }

    #[test]
    fn emails_are_lowercased_and_trimmed() {
        assert_eq!(
            parse_identifier("  Ada@Example.COM ").unwrap(),
            Identifier::Email("ada@example.com".into())
        );
    }

    #[test]
    fn at_sign_decides_before_digits_do() {
        // Starts with digits but is plainly an email. Treating it as a phone
        // would send an SMS nowhere and lock the user out.
        let parsed = parse_identifier("08012345678@gmail.com").unwrap();
        assert!(matches!(parsed, Identifier::Email(_)));
        assert_eq!(parsed.channel(), Channel::Email);
    }

    #[test]
    fn rejects_malformed_emails() {
        for input in [
            "@example.com",   // no local part
            "ada@",           // no domain
            "ada@@x.com",     // two @
            "ada@example",    // no dot in domain
            "ada@.com",       // empty first label
            "ada@example.",   // empty last label
            "ada@ex..com",    // empty middle label
            "ada name@x.com", // whitespace
        ] {
            assert_eq!(
                parse_identifier(input),
                Err(IdentifierError::InvalidEmail),
                "accepted {input}"
            );
        }
    }

    #[test]
    fn rejects_non_ng_mobile_numbers() {
        for input in [
            "0123456789",   // landline prefix
            "0601234567",   // invalid prefix
            "080123456",    // too short
            "080123456789", // too long
            "not a number",
        ] {
            assert_eq!(
                parse_identifier(input),
                Err(IdentifierError::InvalidPhone),
                "accepted {input}"
            );
        }
    }

    #[test]
    fn empty_input_says_so_specifically() {
        assert_eq!(parse_identifier("   "), Err(IdentifierError::Empty));
    }

    #[test]
    fn channel_and_provider_follow_the_kind() {
        let phone = parse_identifier("08012345678").unwrap();
        assert_eq!(phone.channel(), Channel::Sms);
        assert_eq!(phone.provider(), Provider::Phone);

        let email = parse_identifier("ada@example.com").unwrap();
        assert_eq!(email.channel(), Channel::Email);
        assert_eq!(email.provider(), Provider::Email);
    }

    #[test]
    fn masking_hides_the_middle_but_stays_recognisable() {
        assert_eq!(
            parse_identifier("08012345678").unwrap().masked(),
            "+234 801 ••• 5678"
        );
        assert_eq!(
            parse_identifier("adalovelace@example.com").unwrap().masked(),
            "ad•••••••••@example.com"
        );
    }

    #[test]
    fn short_local_parts_are_not_mangled_by_masking() {
        // "a@x.com" has nothing to mask without revealing everything or
        // producing a negative-length repeat — which would panic.
        assert_eq!(parse_identifier("a@x.com").unwrap().masked(), "a@x.com");
        assert_eq!(parse_identifier("ab@x.com").unwrap().masked(), "ab@x.com");
    }

    #[test]
    fn gmail_aliases_stay_distinct() {
        // Documented decision, asserted so nobody "helpfully" collapses them.
        assert_ne!(
            parse_identifier("a.b@gmail.com").unwrap(),
            parse_identifier("ab@gmail.com").unwrap()
        );
    }
}
