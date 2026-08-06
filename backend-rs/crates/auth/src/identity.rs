//! Identity linking.
//!
//! One user can prove who they are by phone number or by email.
//! Deciding whether an incoming sign-in is a returning user, a new sign-in method
//! for an existing user, or a genuinely new person is the single most
//! consequential branch in the auth system:
//!
//! * link too eagerly → one user takes over another's account **and balance**
//! * link too reluctantly → one person ends up with two accounts and two sets of
//!   wallets, and money deposited against one is invisible from the other
//!
//! The resolution rules live here as a pure function so they can be tested
//! exhaustively without a database.

use crate::identifier::Identifier;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

/// How a user proves who they are.
///
/// Both are OTP channels — there is no OAuth. Dropping Google/Apple removed the
/// per-platform client-id configuration and, because Apple's Sign in with Apple
/// requirement (App Store Guideline 4.8) only binds apps offering a *third-party*
/// social login, the obligation to implement it as well.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Phone,
    Email,
}

impl Provider {
    pub const fn as_str(self) -> &'static str {
        match self {
            Provider::Phone => "phone",
            Provider::Email => "email",
        }
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A sign-in attempt whose OTP has **already been verified**.
///
/// Constructing one of these is an assertion that the code was correct. Nothing
/// in this module re-checks it, so it must never be built from raw request input
/// — use [`IdentityClaim::from_verified_otp`] at the point the OTP is consumed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityClaim {
    pub provider: Provider,
    /// The identifier itself: E.164 for phone, normalised address for email.
    pub subject: String,
    /// Set only when ownership of the address was proven by a completed OTP.
    pub verified_email: Option<String>,
    /// Set only when ownership of the number was proven by a completed OTP.
    pub verified_phone: Option<String>,
}

impl IdentityClaim {
    /// Build a claim from an identifier whose OTP has just been consumed.
    ///
    /// Completing an OTP proves control of that exact channel and *only* that
    /// channel, so exactly one of the verified fields is ever populated. Filling
    /// both from a single code would let a phone sign-in claim an email account.
    pub fn from_verified_otp(identifier: &Identifier) -> Self {
        let subject = identifier.subject().to_owned();
        match identifier {
            Identifier::Phone(phone) => Self {
                provider: Provider::Phone,
                subject,
                verified_email: None,
                verified_phone: Some(phone.clone()),
            },
            Identifier::Email(email) => Self {
                provider: Provider::Email,
                subject,
                verified_email: Some(email.clone()),
                verified_phone: None,
            },
        }
    }
}

/// What the database found for an incoming claim. Populated by the repository
/// layer; kept as plain data so the decision below stays pure.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExistingMatches {
    /// Exact `(provider, subject)` hit — this exact identity has signed in before.
    pub by_subject: Option<Uuid>,
    /// A user with a *verified* identity carrying the same email.
    pub by_verified_email: Option<Uuid>,
    /// A user with a *verified* identity carrying the same phone.
    pub by_verified_phone: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// Returning user, identity already known. Just issue a session.
    Existing(Uuid),
    /// Known user signing in a new way. Attach the identity, then issue a session.
    LinkTo(Uuid),
    /// Nobody matches. Create a user and provision wallets.
    CreateNew,
    /// The claim matches two *different* users. Refuse and escalate — merging
    /// custodial accounts automatically could move one person's funds under
    /// another person's control.
    Conflict { email_user: Uuid, phone_user: Uuid },
}

/// Decide what an incoming verified identity means.
///
/// Rule order matters, and every branch below is load-bearing:
///
/// 1. exact identity match wins outright
/// 2. otherwise link on a **verified** contact channel
/// 3. otherwise create a new user
///
/// Step 2 never consults unverified data. That restriction is what stops someone
/// signing up with `victim@gmail.com` and inheriting the victim's balance.
pub fn resolve(claim: &IdentityClaim, found: &ExistingMatches) -> Resolution {
    if let Some(user_id) = found.by_subject {
        return Resolution::Existing(user_id);
    }

    // Only channels the claim itself attests to are eligible for linking. A match
    // found against an address the provider did not verify is not evidence.
    let email_match = claim.verified_email.as_ref().and(found.by_verified_email);
    let phone_match = claim.verified_phone.as_ref().and(found.by_verified_phone);

    match (email_match, phone_match) {
        (Some(a), Some(b)) if a != b => Resolution::Conflict {
            email_user: a,
            phone_user: b,
        },
        (Some(user_id), _) | (None, Some(user_id)) => Resolution::LinkTo(user_id),
        (None, None) => Resolution::CreateNew,
    }
}

// Normalisation lives in `identifier`, which is the only place that decides what
// a phone number or an email *is*. Re-exported rather than reimplemented: two
// copies of these rules would eventually disagree, and a disagreement here means
// the same human is stored as two users with two sets of wallets.
pub use crate::identifier::{normalize_email, normalize_ng_phone};

#[cfg(test)]
mod tests {
    use super::*;

    fn user() -> Uuid {
        Uuid::new_v4()
    }

    /// An email sign-in whose OTP was completed.
    fn email_claim(email: &str) -> IdentityClaim {
        IdentityClaim::from_verified_otp(&Identifier::Email(email.into()))
    }

    /// An email sign-in whose OTP was *not* completed — the shape an attacker
    /// controls before proving anything.
    fn unverified_email_claim(email: &str) -> IdentityClaim {
        IdentityClaim {
            provider: Provider::Email,
            subject: email.into(),
            verified_email: None,
            verified_phone: None,
        }
    }

    fn phone_claim(phone: &str) -> IdentityClaim {
        IdentityClaim::from_verified_otp(&Identifier::Phone(phone.into()))
    }

    #[test]
    fn returning_user_is_recognised_by_subject() {
        let u = user();
        let found = ExistingMatches {
            by_subject: Some(u),
            ..Default::default()
        };
        assert_eq!(
            resolve(&email_claim("a@x.com"), &found),
            Resolution::Existing(u)
        );
    }

    #[test]
    fn subject_match_wins_over_everything_else() {
        // Even if contact channels point elsewhere, a known identity is decisive.
        let known = user();
        let found = ExistingMatches {
            by_subject: Some(known),
            by_verified_email: Some(user()),
            by_verified_phone: Some(user()),
        };
        assert_eq!(
            resolve(&email_claim("a@x.com"), &found),
            Resolution::Existing(known)
        );
    }

    #[test]
    fn brand_new_user_is_created() {
        assert_eq!(
            resolve(&email_claim("new@x.com"), &ExistingMatches::default()),
            Resolution::CreateNew
        );
    }

    #[test]
    fn email_links_to_account_created_by_phone() {
        // The headline case: signed up by phone in January, taps "Continue with
        // email in March. Must be one account, not two.
        let u = user();
        let found = ExistingMatches {
            by_verified_email: Some(u),
            ..Default::default()
        };
        assert_eq!(
            resolve(&email_claim("same@x.com"), &found),
            Resolution::LinkTo(u)
        );
    }

    #[test]
    fn phone_links_to_account_created_by_email() {
        let u = user();
        let found = ExistingMatches {
            by_verified_phone: Some(u),
            ..Default::default()
        };
        assert_eq!(
            resolve(&phone_claim("+2348012345678"), &found),
            Resolution::LinkTo(u)
        );
    }

    /// The account-takeover case. An unverified email must never link.
    #[test]
    fn unverified_email_cannot_hijack_an_account() {
        let victim = user();
        let found = ExistingMatches {
            by_verified_email: Some(victim),
            ..Default::default()
        };
        // `None` here represents `email_verified: false` from the provider.
        let attacker = unverified_email_claim("victim@x.com");
        assert_eq!(
            resolve(&attacker, &found),
            Resolution::CreateNew,
            "an unverified email linked to an existing account — this is account takeover"
        );
    }

    #[test]
    fn split_identity_across_two_users_is_a_conflict_not_a_guess() {
        let email_user = user();
        let phone_user = user();
        let claim = IdentityClaim {
            provider: Provider::Email,
            subject: "sub-new".into(),
            verified_email: Some("a@x.com".into()),
            verified_phone: Some("+2348012345678".into()),
        };
        let found = ExistingMatches {
            by_subject: None,
            by_verified_email: Some(email_user),
            by_verified_phone: Some(phone_user),
        };
        assert_eq!(
            resolve(&claim, &found),
            Resolution::Conflict {
                email_user,
                phone_user
            }
        );
    }

    #[test]
    fn same_user_on_both_channels_links_cleanly() {
        let u = user();
        let claim = IdentityClaim {
            provider: Provider::Phone,
            subject: "apple-sub".into(),
            verified_email: Some("a@x.com".into()),
            verified_phone: Some("+2348012345678".into()),
        };
        let found = ExistingMatches {
            by_subject: None,
            by_verified_email: Some(u),
            by_verified_phone: Some(u),
        };
        assert_eq!(resolve(&claim, &found), Resolution::LinkTo(u));
    }

    #[test]
    fn ng_phone_formats_all_normalise_to_one_identity() {
        let expected = Some("+2348012345678".to_string());
        for input in [
            "08012345678",
            "+2348012345678",
            "2348012345678",
            "234 801 234 5678",
            "0801-234-5678",
            "8012345678",
        ] {
            assert_eq!(normalize_ng_phone(input), expected, "failed on {input}");
        }
    }

    #[test]
    fn rejects_non_ng_mobile_numbers() {
        for input in [
            "0123456789",    // landline prefix
            "0601234567",    // invalid prefix
            "080123456",     // too short
            "080123456789",  // too long
            "",
            "not a number",
        ] {
            assert_eq!(normalize_ng_phone(input), None, "accepted {input}");
        }
    }

    #[test]
    fn email_normalisation_is_case_and_space_insensitive() {
        assert_eq!(
            normalize_email("  User@Example.COM "),
            Some("user@example.com".into())
        );
        assert_eq!(normalize_email("nope"), None);
        assert_eq!(normalize_email("@x.com"), None);
        assert_eq!(normalize_email(""), None);
    }

    #[test]
    fn gmail_aliases_stay_distinct() {
        // Documented decision, asserted so nobody "helpfully" collapses them.
        assert_ne!(
            normalize_email("a.b@gmail.com"),
            normalize_email("ab@gmail.com")
        );
    }
}
