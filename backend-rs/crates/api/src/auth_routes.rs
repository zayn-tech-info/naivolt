//! Auth endpoints: request a code, verify it, set a PIN, refresh a session.

use crate::error::{ApiError, ApiResult};
use crate::notify::Notifier;
use crate::signer::AddressProvider;
use crate::state::AppState;
use axum::extract::State;
use axum::{Json, Router};
use axum::routing::post;
use chrono::Utc;
use naivolt_auth::identifier::{parse_identifier, Channel, Identifier};
use naivolt_auth::identity::{resolve, ExistingMatches, IdentityClaim, Resolution};
use naivolt_auth::session::{evaluate_refresh, hash_refresh, issue_refresh, RefreshOutcome, StoredSession};
use naivolt_auth::OtpChallenge;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/otp/request", post(request_otp))
        .route("/auth/otp/verify", post(verify_otp))
        .route("/auth/refresh", post(refresh))
}

// ---------------------------------------------------------------------------
// POST /auth/otp/request
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RequestOtpBody {
    pub identifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOtpResponse {
    pub channel: &'static str,
    /// Seconds until a resend is allowed.
    pub retry_after: i64,
    /// Masked, so the client can say where it went without echoing the address.
    pub sent_to: String,
}

async fn request_otp(
    State(state): State<AppState>,
    Json(body): Json<RequestOtpBody>,
) -> ApiResult<Json<RequestOtpResponse>> {
    let identifier = parse_identifier(&body.identifier)?;
    let now = Utc::now();

    let mut tx = state.db.begin().await?;

    // Cooldown applies to the *destination*, not to a live challenge.
    //
    // Scoping this to `consumed_at IS NULL` left a hole: a completed sign-in
    // consumes the challenge, and every subsequent request then found nothing to
    // rate-limit against. Anyone able to trigger one successful verify could then
    // drive unlimited sends to that number — real money per message, and enough
    // volume to get a sender ID blacklisted by the carrier.
    //
    // FOR UPDATE holds the row so two concurrent requests cannot both pass.
    let existing: Option<(chrono::DateTime<Utc>,)> = sqlx::query_as(
        "SELECT last_sent_at FROM otp_challenges
          WHERE destination = $1
          ORDER BY last_sent_at DESC
          LIMIT 1
          FOR UPDATE",
    )
    .bind(identifier.subject())
    .fetch_optional(&mut *tx)
    .await?;

    if let Some((last_sent_at,)) = existing {
        let elapsed = (now - last_sent_at).num_seconds();
        let cooldown = naivolt_auth::otp::RESEND_COOLDOWN_SECONDS;
        if elapsed < cooldown {
            // Each send costs money and floods get sender IDs blacklisted by
            // carriers, so this is a hard stop rather than a soft warning.
            return Err(ApiError::OtpThrottled {
                retry_after: cooldown - elapsed,
            });
        }
    }

    // A fixed code in development saves reading it out of the server log on
    // every sign-in. `state.dev_otp_code` is None in production — Config refuses
    // to boot otherwise — so this branch cannot exist where real accounts do.
    let code = match &state.dev_otp_code {
        Some(fixed) => fixed.clone(),
        None => naivolt_auth::otp::generate_code(),
    };
    let challenge = OtpChallenge::new(&identifier, &code, now)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    // Replace rather than accumulate: the partial unique index allows only one
    // live challenge per destination, and an old code staying valid alongside a
    // new one doubles an attacker's guessing surface.
    sqlx::query("DELETE FROM otp_challenges WHERE destination = $1 AND consumed_at IS NULL")
        .bind(identifier.subject())
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO otp_challenges (destination, channel, code_hash, expires_at, last_sent_at)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(challenge.destination.as_str())
    .bind(channel_str(challenge.channel))
    .bind(&challenge.code_hash)
    .bind(challenge.expires_at)
    .bind(challenge.last_sent_at)
    .execute(&mut *tx)
    .await?;

    // Send *before* committing. If delivery fails the transaction rolls back and
    // no challenge exists — better than a stored code the user never received,
    // which would block a retry for the whole cooldown window.
    state
        .notifier
        .send_code(&challenge.destination, challenge.channel, &code)
        .await
        .map_err(ApiError::Internal)?;

    tx.commit().await?;

    Ok(Json(RequestOtpResponse {
        channel: channel_str(challenge.channel),
        retry_after: naivolt_auth::otp::RESEND_COOLDOWN_SECONDS,
        sent_to: identifier.masked(),
    }))
}

// ---------------------------------------------------------------------------
// POST /auth/otp/verify
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOtpBody {
    pub identifier: String,
    pub code: String,
    pub device_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub token: String,
    pub refresh_token: String,
    pub is_new_account: bool,
    pub user: UserResponse,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserResponse {
    pub id: Uuid,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub kyc_tier: i16,
    pub has_pin: bool,
}

async fn verify_otp(
    State(state): State<AppState>,
    Json(body): Json<VerifyOtpBody>,
) -> ApiResult<Json<SessionResponse>> {
    let identifier = parse_identifier(&body.identifier)?;
    let now = Utc::now();

    let mut tx = state.db.begin().await?;

    let row: Option<ChallengeRow> = sqlx::query_as(
        "SELECT id, code_hash, attempts, expires_at, consumed_at
           FROM otp_challenges
          WHERE destination = $1 AND consumed_at IS NULL
          FOR UPDATE",
    )
    .bind(identifier.subject())
    .fetch_optional(&mut *tx)
    .await?;

    let Some(ChallengeRow { id: challenge_id, code_hash, attempts, expires_at, consumed_at }) = row
    else {
        // No live challenge. Deliberately the same error as an expired one: a
        // distinct "no code was ever requested for this address" would let an
        // attacker enumerate which numbers and emails have accounts.
        return Err(ApiError::OtpExpired);
    };

    let mut challenge = OtpChallenge {
        destination: identifier.subject().to_owned(),
        channel: identifier.channel(),
        code_hash,
        expires_at,
        attempts,
        consumed_at,
        last_sent_at: now,
    };

    let result = challenge.verify(&body.code, now);

    // Persist the attempt count whatever the outcome, and commit it even on
    // failure — otherwise a rollback would hand back unlimited free guesses.
    sqlx::query("UPDATE otp_challenges SET attempts = $1, consumed_at = $2 WHERE id = $3")
        .bind(challenge.attempts)
        .bind(challenge.consumed_at)
        .bind(challenge_id)
        .execute(&mut *tx)
        .await?;

    if let Err(err) = result {
        tx.commit().await?;
        return Err(err.into());
    }

    // From here the code is proven. Everything below is one atomic unit: a user
    // created without wallets, or with wallets but no session, is a broken account.
    let claim = IdentityClaim::from_verified_otp(&identifier);
    let matches = lookup_matches(&mut tx, &claim).await?;

    let (user_id, is_new_account) = match resolve(&claim, &matches) {
        Resolution::Existing(id) => (id, false),
        Resolution::LinkTo(id) => {
            attach_identity(&mut tx, id, &claim).await?;
            (id, false)
        }
        Resolution::CreateNew => {
            let id = create_user(&mut tx, &state, &claim, &identifier).await?;
            (id, true)
        }
        Resolution::Conflict { .. } => {
            // Two different users hold these channels. Merging custodial accounts
            // automatically could move one person's funds under another's control,
            // so this stops here and goes to a human.
            tracing::error!(
                identifier = %identifier.masked(),
                "identity conflict — manual review required"
            );
            return Err(ApiError::BadRequest(
                "We can't sign you in automatically. Please contact support.".into(),
            ));
        }
    };

    let user = load_user(&mut tx, user_id).await?;
    let session = start_session(&mut tx, &state, user_id, user.kyc_tier, body.device_id, now).await?;

    tx.commit().await?;

    Ok(Json(SessionResponse {
        token: session.0,
        refresh_token: session.1,
        is_new_account,
        user,
    }))
}

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshBody {
    pub refresh_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResponse {
    pub token: String,
    pub refresh_token: String,
}

async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<RefreshBody>,
) -> ApiResult<Json<RefreshResponse>> {
    let now = Utc::now();
    let presented = hash_refresh(&body.refresh_token);

    let mut tx = state.db.begin().await?;

    let row: Option<StoredSessionRow> = sqlx::query_as(
        "SELECT id, user_id, family_id, expires_at, rotated_at, revoked_at
           FROM sessions WHERE refresh_token_hash = $1 FOR UPDATE",
    )
    .bind(&presented)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        return Err(ApiError::Unauthorized);
    };

    let stored = StoredSession {
        id: row.id,
        user_id: row.user_id,
        family_id: row.family_id,
        expires_at: row.expires_at,
        rotated_at: row.rotated_at,
        revoked_at: row.revoked_at,
    };

    match evaluate_refresh(&stored, now) {
        RefreshOutcome::ReuseDetected { family_id } => {
            // Two parties hold this token. We cannot tell which is the real user,
            // so the entire family dies and both must sign in again.
            sqlx::query(
                "UPDATE sessions SET revoked_at = $1 WHERE family_id = $2 AND revoked_at IS NULL",
            )
            .bind(now)
            .bind(family_id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;

            tracing::warn!(%family_id, "refresh token reuse — family revoked");
            Err(ApiError::Unauthorized)
        }
        RefreshOutcome::Rejected => Err(ApiError::Unauthorized),
        RefreshOutcome::Rotate { user_id, family_id } => {
            sqlx::query("UPDATE sessions SET rotated_at = $1 WHERE id = $2")
                .bind(now)
                .bind(stored.id)
                .execute(&mut *tx)
                .await?;

            let tier: i16 = sqlx::query_scalar("SELECT kyc_tier FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_one(&mut *tx)
                .await?;

            let next = issue_refresh(Some(family_id), now);
            sqlx::query(
                "INSERT INTO sessions (user_id, family_id, refresh_token_hash, expires_at)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(user_id)
            .bind(family_id)
            .bind(&next.hash)
            .bind(next.expires_at)
            .execute(&mut *tx)
            .await?;

            let access = state
                .keys
                .issue_access(user_id, family_id, tier, now)
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

            tx.commit().await?;

            Ok(Json(RefreshResponse {
                token: access,
                refresh_token: next.secret,
            }))
        }
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct ChallengeRow {
    id: Uuid,
    code_hash: String,
    attempts: i32,
    expires_at: chrono::DateTime<Utc>,
    consumed_at: Option<chrono::DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct StoredSessionRow {
    id: Uuid,
    user_id: Uuid,
    family_id: Uuid,
    expires_at: chrono::DateTime<Utc>,
    rotated_at: Option<chrono::DateTime<Utc>>,
    revoked_at: Option<chrono::DateTime<Utc>>,
}

fn channel_str(channel: Channel) -> &'static str {
    match channel {
        Channel::Sms => "sms",
        Channel::Email => "email",
    }
}

async fn lookup_matches(
    tx: &mut Transaction<'_, Postgres>,
    claim: &IdentityClaim,
) -> ApiResult<ExistingMatches> {
    let by_subject = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM identities WHERE provider = $1 AND subject = $2",
    )
    .bind(claim.provider.as_str())
    .bind(&claim.subject)
    .fetch_optional(&mut **tx)
    .await?;

    // Only *verified* rows are eligible, which is the restriction that stops
    // someone claiming an account by signing up with its owner's address.
    let by_verified_email = match &claim.verified_email {
        Some(email) => {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT user_id FROM identities
                  WHERE email = $1 AND verified_at IS NOT NULL LIMIT 1",
            )
            .bind(email)
            .fetch_optional(&mut **tx)
            .await?
        }
        None => None,
    };

    let by_verified_phone = match &claim.verified_phone {
        Some(phone) => {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT user_id FROM identities
                  WHERE phone = $1 AND verified_at IS NOT NULL LIMIT 1",
            )
            .bind(phone)
            .fetch_optional(&mut **tx)
            .await?
        }
        None => None,
    };

    Ok(ExistingMatches {
        by_subject,
        by_verified_email,
        by_verified_phone,
    })
}

async fn attach_identity(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    claim: &IdentityClaim,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO identities (user_id, provider, subject, email, phone, verified_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (provider, subject) DO NOTHING",
    )
    .bind(user_id)
    .bind(claim.provider.as_str())
    .bind(&claim.subject)
    .bind(&claim.verified_email)
    .bind(&claim.verified_phone)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn create_user(
    tx: &mut Transaction<'_, Postgres>,
    state: &AppState,
    claim: &IdentityClaim,
    identifier: &Identifier,
) -> ApiResult<Uuid> {
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (phone, email) VALUES ($1, $2) RETURNING id",
    )
    .bind(&claim.verified_phone)
    .bind(&claim.verified_email)
    .fetch_one(&mut **tx)
    .await?;

    attach_identity(tx, user_id, claim).await?;

    let address_index: i64 = sqlx::query_scalar("SELECT address_index FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?;

    let index = u32::try_from(address_index)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("address index {address_index} out of range")))?;

    // Wallets are provisioned inside the same transaction as the user. A user
    // that exists without addresses would be told to deposit to nothing.
    let derived = state
        .addresses
        .derive_all(index)
        .await
        .map_err(ApiError::Internal)?;

    for address in derived {
        sqlx::query(
            "INSERT INTO wallets (user_id, chain, address, derivation_path)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(user_id)
        .bind(address.chain.as_str())
        .bind(&address.address)
        .bind(&address.derivation_path)
        .execute(&mut **tx)
        .await?;
    }

    tracing::info!(%user_id, identifier = %identifier.masked(), "account created");
    Ok(user_id)
}

async fn load_user(tx: &mut Transaction<'_, Postgres>, user_id: Uuid) -> ApiResult<UserResponse> {
    let row: (Uuid, Option<String>, Option<String>, i16, Option<String>) = sqlx::query_as(
        "SELECT id, phone, email, kyc_tier, pin_hash FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;

    Ok(UserResponse {
        id: row.0,
        display_name: None,
        phone: row.1,
        email: row.2,
        kyc_tier: row.3,
        has_pin: row.4.is_some(),
    })
}

/// Create a session row and return `(access_token, refresh_secret)`.
async fn start_session(
    tx: &mut Transaction<'_, Postgres>,
    state: &AppState,
    user_id: Uuid,
    tier: i16,
    device_id: Option<String>,
    now: chrono::DateTime<Utc>,
) -> ApiResult<(String, String)> {
    let refresh = issue_refresh(None, now);

    sqlx::query(
        "INSERT INTO sessions (user_id, family_id, refresh_token_hash, device_id, expires_at)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(user_id)
    .bind(refresh.family_id)
    .bind(&refresh.hash)
    .bind(device_id)
    .bind(refresh.expires_at)
    .execute(&mut **tx)
    .await?;

    let access = state
        .keys
        .issue_access(user_id, refresh.family_id, tier, now)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e)))?;

    Ok((access, refresh.secret))
}
