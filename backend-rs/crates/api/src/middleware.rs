//! Bearer-token extraction.
//!
//! Any handler taking [`CurrentUser`] is authenticated: the extractor rejects
//! the request before the handler body runs, so there is no path where a route
//! forgets to check.

use crate::error::ApiError;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use naivolt_auth::session::AccessClaims;
use uuid::Uuid;

#[allow(dead_code)] // read by the payout and session-revocation handlers
pub struct CurrentUser {
    pub id: Uuid,
    /// Tier as it was when the token was minted. Anything gating on tier must
    /// re-read it from the database — a token issued before a tier change stays
    /// valid for up to 15 minutes, and a stale tier here would let a user
    /// withdraw against limits they no longer have.
    pub tier_at_issue: i16,
    pub session_family: Uuid,
}

#[axum::async_trait]
impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(ApiError::Unauthorized)?;

        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .ok_or(ApiError::Unauthorized)?;

        let claims: AccessClaims = state
            .keys
            .verify_access(token.trim())
            .map_err(|_| ApiError::Unauthorized)?;

        Ok(CurrentUser {
            id: claims.sub,
            tier_at_issue: claims.tier,
            session_family: claims.sid,
        })
    }
}
