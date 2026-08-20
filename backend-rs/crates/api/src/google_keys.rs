//! Google's signing keys, fetched and cached.
//!
//! Verifying an ID token needs the public key Google signed it with, selected by
//! the `kid` in the token header. Google rotates those keys on its own schedule
//! and publishes the current set at a well-known URL.
//!
//! Two behaviours here are load-bearing. The set is cached, because fetching it
//! per sign-in would put Google's availability directly in front of our login.
//! And an unknown `kid` forces a refetch rather than a rejection — the first
//! token signed with a newly rotated key always has a `kid` the cache has never
//! seen, and treating that as a bad token would lock every user out at the
//! moment of rotation.

use crate::error::{ApiError, ApiResult};
use naivolt_auth::oidc::DecodingKey;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
/// Well inside Google's own rotation cadence. Rotation is handled by the
/// unknown-kid refetch anyway; this only bounds how stale a *working* set gets.
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);
/// Stops a burst of sign-ins with a bogus kid turning into a burst of fetches.
const MIN_REFETCH_INTERVAL: Duration = Duration::from_secs(30);

pub struct GoogleKeys {
    http: reqwest::Client,
    cache: RwLock<Option<Cached>>,
}

struct Cached {
    keys: HashMap<String, DecodingKey>,
    fetched_at: Instant,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<JwkKey>,
}

#[derive(Deserialize)]
struct JwkKey {
    kid: String,
    /// RSA modulus, base64url.
    n: String,
    /// RSA exponent, base64url.
    e: String,
    #[serde(default)]
    kty: String,
}

impl GoogleKeys {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            cache: RwLock::new(None),
        }
    }

    /// The key for `kid`, refetching if the cache is stale or does not have it.
    pub async fn decoding_key(&self, kid: &str) -> ApiResult<DecodingKey> {
        {
            let cache = self.cache.read().await;
            if let Some(cached) = cache.as_ref() {
                if cached.fetched_at.elapsed() < CACHE_TTL {
                    if let Some(key) = cached.keys.get(kid) {
                        return Ok(key.clone());
                    }
                    // Unknown kid inside a fresh cache means either a rotation we
                    // have not seen or a forged header. Refetch, but not on every
                    // request — a forged kid must not become a fetch amplifier.
                    if cached.fetched_at.elapsed() < MIN_REFETCH_INTERVAL {
                        return Err(ApiError::Unauthorized);
                    }
                }
            }
        }

        let keys = self.fetch().await?;
        let key = keys.get(kid).cloned();

        *self.cache.write().await = Some(Cached {
            keys,
            fetched_at: Instant::now(),
        });

        // Still absent after a fresh fetch: Google does not have this key, so
        // nothing signed with it is from Google.
        key.ok_or(ApiError::Unauthorized)
    }

    async fn fetch(&self) -> ApiResult<HashMap<String, DecodingKey>> {
        let jwks: Jwks = self
            .http
            .get(JWKS_URL)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| {
                tracing::warn!(error = %e, "google jwks fetch failed");
                ApiError::ServiceUnavailable("Google sign-in is unavailable right now.".into())
            })?
            .json()
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, "google jwks returned unreadable body");
                ApiError::ServiceUnavailable("Google sign-in is unavailable right now.".into())
            })?;

        let keys: HashMap<String, DecodingKey> = jwks
            .keys
            .into_iter()
            // RSA only. An EC or symmetric key here would be built into a
            // DecodingKey of the wrong type and fail confusingly at verify time.
            .filter(|k| k.kty.is_empty() || k.kty == "RSA")
            .filter_map(|k| {
                DecodingKey::from_rsa_components(&k.n, &k.e)
                    .inspect_err(|e| tracing::warn!(error = %e, kid = %k.kid, "unusable jwks key"))
                    .ok()
                    .map(|key| (k.kid, key))
            })
            .collect();

        if keys.is_empty() {
            tracing::error!("google jwks contained no usable keys");
            return Err(ApiError::ServiceUnavailable(
                "Google sign-in is unavailable right now.".into(),
            ));
        }

        Ok(keys)
    }
}

impl Default for GoogleKeys {
    fn default() -> Self {
        Self::new()
    }
}
