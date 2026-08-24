//! The error envelope.
//!
//! Every failure the client can act on carries a machine-readable `code`; the
//! client branches on the code and displays `message` verbatim. See
//! `docs/API-CONTRACT.md` §1.
//!
//! Two rules hold this together:
//!
//! * `message` is user-facing, so it must never contain a stack trace, an
//!   internal identifier, or SQL. Anything unexpected is flattened to a generic
//!   message and the detail goes to the log instead.
//! * an error the client must branch on needs its own code. A bare 400 with
//!   prose cannot be branched on, and each code below drives different UI.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)] // several variants are raised by handlers still being built
pub enum ApiError {
    // --- auth ---
    #[error("that code isn't right")]
    OtpInvalid { attempts_remaining: i32 },
    #[error("that code has expired")]
    OtpExpired,
    #[error("too many attempts, try again shortly")]
    OtpThrottled { retry_after: i64 },
    #[error("that PIN isn't right")]
    PinInvalid { attempts_remaining: i32 },
    #[error("PIN entry is locked")]
    PinLocked { retry_after: i64 },
    #[error("please sign in again")]
    Unauthorized,

    // --- money ---
    #[error("not enough balance")]
    InsufficientBalance,
    #[error("that would go over your limit")]
    LimitExceeded { limit: String },
    #[error("verification required")]
    KycRequired { next_step: String },
    #[error("that rate expired")]
    QuoteExpired,
    #[error("that quote was already used")]
    QuoteConsumed,
    /// The catalogue price moved between the page the user read it from and the
    /// order they placed. Carries the current price so the client can show what
    /// it is now rather than making them reload and guess what changed.
    #[error("that price changed to ₦{price_ngn}")]
    PriceMoved { price_ngn: String },
    #[error("this bank account isn't verified yet")]
    BankUnverified,
    #[error("{asset} is paused right now")]
    AssetPaused { asset: String },
    /// A dependency we cannot quote without is down. Distinct from Internal:
    /// nothing is broken, the answer is just not available yet, and retrying is
    /// the right move rather than reporting a bug.
    #[error("{0}")]
    ServiceUnavailable(String),

    // --- generic ---
    #[error("{0}")]
    BadRequest(String),
    #[error("not found")]
    NotFound,
    /// Anything unexpected. The inner detail is logged, never sent.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl ApiError {
    fn code(&self) -> &'static str {
        match self {
            ApiError::OtpInvalid { .. } => "OTP_INVALID",
            ApiError::OtpExpired => "OTP_EXPIRED",
            ApiError::OtpThrottled { .. } => "OTP_THROTTLED",
            ApiError::PinInvalid { .. } => "PIN_INVALID",
            ApiError::PinLocked { .. } => "PIN_LOCKED",
            ApiError::Unauthorized => "UNAUTHORIZED",
            ApiError::InsufficientBalance => "INSUFFICIENT_BALANCE",
            ApiError::LimitExceeded { .. } => "LIMIT_EXCEEDED",
            ApiError::KycRequired { .. } => "KYC_REQUIRED",
            ApiError::QuoteExpired => "QUOTE_EXPIRED",
            ApiError::QuoteConsumed => "QUOTE_CONSUMED",
            ApiError::PriceMoved { .. } => "PRICE_MOVED",
            ApiError::BankUnverified => "BANK_UNVERIFIED",
            ApiError::AssetPaused { .. } => "ASSET_PAUSED",
            ApiError::ServiceUnavailable(_) => "SERVICE_UNAVAILABLE",
            ApiError::BadRequest(_) => "BAD_REQUEST",
            ApiError::NotFound => "NOT_FOUND",
            ApiError::Internal(_) => "INTERNAL",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            ApiError::OtpInvalid { .. } | ApiError::PinInvalid { .. } | ApiError::Unauthorized => {
                StatusCode::UNAUTHORIZED
            }
            ApiError::OtpExpired => StatusCode::GONE,
            ApiError::OtpThrottled { .. } => StatusCode::TOO_MANY_REQUESTS,
            ApiError::PinLocked { .. } => StatusCode::LOCKED,
            ApiError::InsufficientBalance
            | ApiError::LimitExceeded { .. }
            | ApiError::BankUnverified => StatusCode::UNPROCESSABLE_ENTITY,
            ApiError::KycRequired { .. } => StatusCode::FORBIDDEN,
            ApiError::QuoteExpired | ApiError::QuoteConsumed | ApiError::PriceMoved { .. } => {
                StatusCode::CONFLICT
            }
            ApiError::AssetPaused { .. } | ApiError::ServiceUnavailable(_) => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::NotFound => StatusCode::NOT_FOUND,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Extra structured detail the client needs to render the error properly —
    /// a retry deadline, the limit that was hit, the next KYC step.
    fn meta(&self) -> Option<Value> {
        match self {
            ApiError::OtpInvalid {
                attempts_remaining,
            }
            | ApiError::PinInvalid {
                attempts_remaining,
            } => Some(json!({ "attemptsRemaining": attempts_remaining })),
            ApiError::OtpThrottled { retry_after } | ApiError::PinLocked { retry_after } => {
                Some(json!({ "retryAfter": retry_after }))
            }
            ApiError::LimitExceeded { limit } => Some(json!({ "limit": limit })),
            ApiError::KycRequired { next_step } => Some(json!({ "nextStep": next_step })),
            ApiError::AssetPaused { asset } => Some(json!({ "asset": asset })),
            ApiError::PriceMoved { price_ngn } => Some(json!({ "priceNgn": price_ngn })),
            _ => None,
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<Value>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // The only branch that must not leak: an internal error's Display may
        // carry a database message, a connection string, or a query. Log it in
        // full, send the user nothing but a generic line.
        let message = match &self {
            ApiError::Internal(err) => {
                tracing::error!(error = ?err, "internal error");
                "Something went wrong on our end. Please try again.".to_owned()
            }
            other => other.to_string(),
        };

        let body = ErrorBody {
            code: self.code(),
            message,
            meta: self.meta(),
        };

        (self.status(), Json(body)).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        match err {
            sqlx::Error::RowNotFound => ApiError::NotFound,
            other => ApiError::Internal(other.into()),
        }
    }
}

impl From<naivolt_auth::IdentifierError> for ApiError {
    fn from(err: naivolt_auth::IdentifierError) -> Self {
        // These messages are written for users and are safe to display.
        ApiError::BadRequest(err.to_string())
    }
}

impl From<naivolt_auth::OtpError> for ApiError {
    fn from(err: naivolt_auth::OtpError) -> Self {
        use naivolt_auth::OtpError;
        match err {
            OtpError::Expired => ApiError::OtpExpired,
            // A used code and an exhausted challenge are both "start over", and
            // distinguishing them for the client would tell an attacker which of
            // the two states they are in.
            OtpError::AlreadyUsed | OtpError::TooManyAttempts => ApiError::OtpExpired,
            OtpError::Incorrect {
                attempts_remaining,
            } => ApiError::OtpInvalid {
                attempts_remaining,
            },
            OtpError::Hash(e) => ApiError::Internal(anyhow::anyhow!(e)),
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn body_of(err: ApiError) -> (StatusCode, Value) {
        let response = err.into_response();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn internal_errors_never_leak_their_detail() {
        let leaky = ApiError::Internal(anyhow::anyhow!(
            "connection to postgres://user:hunter2@db:5432 failed: relation \"users\" does not exist"
        ));
        let (status, body) = body_of(leaky).await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["code"], "INTERNAL");
        let message = body["message"].as_str().unwrap();
        assert!(!message.contains("postgres"), "leaked a connection string");
        assert!(!message.contains("hunter2"), "leaked a password");
        assert!(!message.contains("relation"), "leaked SQL detail");
    }

    #[tokio::test]
    async fn user_facing_errors_keep_their_message_and_code() {
        let (status, body) = body_of(ApiError::QuoteExpired).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "QUOTE_EXPIRED");
        assert_eq!(body["message"], "that rate expired");
    }

    #[tokio::test]
    async fn attempts_remaining_reaches_the_client() {
        let (_, body) = body_of(ApiError::OtpInvalid {
            attempts_remaining: 3,
        })
        .await;
        assert_eq!(body["meta"]["attemptsRemaining"], 3);
    }

    #[tokio::test]
    async fn throttling_tells_the_client_when_to_retry() {
        let (status, body) = body_of(ApiError::OtpThrottled { retry_after: 42 }).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["meta"]["retryAfter"], 42);
    }

    #[tokio::test]
    async fn kyc_required_carries_the_next_step() {
        let (status, body) = body_of(ApiError::KycRequired {
            next_step: "Verify your BVN".into(),
        })
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["code"], "KYC_REQUIRED");
        assert_eq!(body["meta"]["nextStep"], "Verify your BVN");
    }

    #[tokio::test]
    async fn a_used_code_is_indistinguishable_from_an_exhausted_one() {
        // Telling them apart would confirm to an attacker whether the code they
        // guessed had already been consumed by the real user.
        let (used, _) = body_of(naivolt_auth::OtpError::AlreadyUsed.into()).await;
        let (exhausted, _) = body_of(naivolt_auth::OtpError::TooManyAttempts.into()).await;
        assert_eq!(used, exhausted);
    }

    #[tokio::test]
    async fn missing_rows_are_404_not_500() {
        let (status, body) = body_of(sqlx::Error::RowNotFound.into()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "NOT_FOUND");
    }
}
