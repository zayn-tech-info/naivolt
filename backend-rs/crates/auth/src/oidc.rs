//! Google and Apple ID token validation.
//!
//! The client performs the OAuth dance and hands us an ID token. Everything that
//! matters happens here: an ID token is only meaningful once its signature,
//! issuer, audience and expiry have all been checked. Skipping any one of them
//! makes the token forgeable, and a forged token is a funded account.

use crate::identity::{normalize_email, IdentityClaim, Provider};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};

pub const GOOGLE_ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
pub const APPLE_ISSUER: &str = "https://appleid.apple.com";

/// Claims we care about from a Google or Apple ID token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcClaims {
    /// Stable, provider-unique user id. Never changes, never reused.
    pub sub: String,
    pub iss: String,
    pub aud: String,
    pub exp: i64,
    #[serde(default)]
    pub email: Option<String>,
    /// Google sends a bool; Apple sends the string `"true"`. Both are handled.
    #[serde(default, deserialize_with = "flexible_bool")]
    pub email_verified: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub picture: Option<String>,
}

/// Apple encodes booleans as strings in ID tokens; Google uses real booleans.
/// Deserializing strictly against one shape silently breaks the other provider.
fn flexible_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{Error, Unexpected};
    match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Bool(b) => Ok(b),
        serde_json::Value::String(s) => match s.as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            other => Err(D::Error::invalid_value(Unexpected::Str(other), &"true or false")),
        },
        serde_json::Value::Null => Ok(false),
        other => Err(D::Error::invalid_type(
            Unexpected::Other(&other.to_string()),
            &"bool or string",
        )),
    }
}

#[derive(Debug, Clone)]
pub struct OidcConfig {
    pub provider: Provider,
    /// Our OAuth client id. Tokens minted for a *different* app are valid tokens
    /// signed by the same issuer — checking `aud` is what stops one being
    /// replayed here.
    pub audience: String,
}

/// Extract the key id from a token header, to select the right JWKS key.
pub fn key_id(token: &str) -> Result<String, OidcError> {
    decode_header(token)
        .map_err(|e| OidcError::Malformed(e.to_string()))?
        .kid
        .ok_or(OidcError::MissingKeyId)
}

/// Verify signature and claims, and convert to a linkable identity.
///
/// `key` comes from the provider's JWKS endpoint, matched on `kid` and cached.
pub fn verify_id_token(
    token: &str,
    key: &DecodingKey,
    config: &OidcConfig,
) -> Result<IdentityClaim, OidcError> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[&config.audience]);
    validation.set_issuer(&expected_issuers(config.provider));
    // `exp` is validated by default; make the intent explicit.
    validation.validate_exp = true;
    // Providers can be a second or two out of step with us.
    validation.leeway = 60;

    let data = decode::<OidcClaims>(token, key, &validation)
        .map_err(|e| OidcError::Invalid(e.to_string()))?;

    claims_to_identity(data.claims, config)
}

fn expected_issuers(provider: Provider) -> Vec<String> {
    match provider {
        Provider::Google => GOOGLE_ISSUERS.iter().map(|s| s.to_string()).collect(),
        Provider::Apple => vec![APPLE_ISSUER.to_string()],
        Provider::Phone => Vec::new(),
    }
}

/// Convert verified claims into an [`IdentityClaim`].
///
/// Split out from signature checking so the trust decisions are testable without
/// minting real RSA-signed tokens.
pub fn claims_to_identity(
    claims: OidcClaims,
    config: &OidcConfig,
) -> Result<IdentityClaim, OidcError> {
    if claims.sub.is_empty() {
        return Err(OidcError::MissingSubject);
    }

    // An email the provider has not verified carries the address but no proof of
    // ownership, so it must not be usable for account linking. We keep the
    // account, we just refuse to treat the address as evidence.
    let verified_email = if claims.email_verified {
        claims.email.as_deref().and_then(normalize_email)
    } else {
        None
    };

    Ok(IdentityClaim {
        provider: config.provider,
        subject: claims.sub,
        verified_email,
        verified_phone: None,
    })
}

#[derive(Debug, thiserror::Error)]
pub enum OidcError {
    #[error("malformed token: {0}")]
    Malformed(String),
    #[error("token header has no key id")]
    MissingKeyId,
    #[error("token rejected: {0}")]
    Invalid(String),
    #[error("token has no subject")]
    MissingSubject,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> OidcConfig {
        OidcConfig {
            provider: Provider::Google,
            audience: "naivolt-ios.apps.googleusercontent.com".into(),
        }
    }

    fn claims(email: &str, verified: bool) -> OidcClaims {
        OidcClaims {
            sub: "112233445566".into(),
            iss: "https://accounts.google.com".into(),
            aud: "naivolt-ios.apps.googleusercontent.com".into(),
            exp: 9_999_999_999,
            email: Some(email.into()),
            email_verified: verified,
            name: Some("Ada Lovelace".into()),
            picture: None,
        }
    }

    #[test]
    fn verified_google_email_becomes_linkable() {
        let identity = claims_to_identity(claims("Ada@Example.com", true), &config()).unwrap();
        assert_eq!(identity.provider, Provider::Google);
        assert_eq!(identity.subject, "112233445566");
        // Normalised on the way in, so linking compares like with like.
        assert_eq!(identity.verified_email.as_deref(), Some("ada@example.com"));
    }

    /// Google returns `email_verified: false` for some Workspace and alias
    /// accounts. Those addresses must not be usable to claim an existing account.
    #[test]
    fn unverified_email_is_dropped_not_trusted() {
        let identity = claims_to_identity(claims("ada@example.com", false), &config()).unwrap();
        assert_eq!(
            identity.verified_email, None,
            "unverified email was treated as proof of ownership"
        );
        // The account is still perfectly usable — it just cannot link by email.
        assert_eq!(identity.subject, "112233445566");
    }

    #[test]
    fn empty_subject_is_rejected() {
        let mut c = claims("ada@example.com", true);
        c.sub = String::new();
        assert!(matches!(
            claims_to_identity(c, &config()),
            Err(OidcError::MissingSubject)
        ));
    }

    #[test]
    fn apple_string_booleans_deserialize() {
        // Apple sends "true" as a JSON string, Google sends true as a bool.
        let apple = r#"{"sub":"a","iss":"https://appleid.apple.com","aud":"x",
                        "exp":1,"email":"a@b.com","email_verified":"true"}"#;
        let parsed: OidcClaims = serde_json::from_str(apple).unwrap();
        assert!(parsed.email_verified);

        let google = r#"{"sub":"a","iss":"https://accounts.google.com","aud":"x",
                         "exp":1,"email":"a@b.com","email_verified":true}"#;
        let parsed: OidcClaims = serde_json::from_str(google).unwrap();
        assert!(parsed.email_verified);
    }

    #[test]
    fn missing_email_verified_defaults_to_unverified() {
        // Absent means "not attested". Defaulting to true would be a takeover bug.
        let json = r#"{"sub":"a","iss":"https://accounts.google.com","aud":"x",
                       "exp":1,"email":"a@b.com"}"#;
        let parsed: OidcClaims = serde_json::from_str(json).unwrap();
        assert!(!parsed.email_verified);
    }

    #[test]
    fn account_with_no_email_still_works() {
        let mut c = claims("", true);
        c.email = None;
        let identity = claims_to_identity(c, &config()).unwrap();
        assert_eq!(identity.verified_email, None);
        assert!(!identity.subject.is_empty());
    }

    #[test]
    fn issuer_list_is_provider_specific() {
        assert_eq!(expected_issuers(Provider::Google).len(), 2);
        assert_eq!(expected_issuers(Provider::Apple), vec![APPLE_ISSUER]);
    }

    #[test]
    fn garbage_token_has_no_key_id() {
        assert!(key_id("not.a.token").is_err());
    }
}
