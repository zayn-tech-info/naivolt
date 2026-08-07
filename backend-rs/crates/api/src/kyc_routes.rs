//! KYC — verifying who someone is, so they can move naira to a bank.
//!
//! Signup asks for nothing; the wall goes up at withdrawal, where value leaves
//! the platform and the AML obligation attaches (ARCHITECTURE.md §10.3). So this
//! is not an onboarding gate — it is a thing users come to when they want to
//! cash out or raise a limit, and the API is shaped for that: read your status,
//! submit the one document the next tier needs.
//!
//! ## What is stored
//!
//! Only the last four digits of a BVN or NIN. The full number goes to the
//! verification provider and is never written here. Storing complete national
//! identifiers turns a database breach into an identity-theft incident, and
//! four digits is enough to display and to reconcile against the provider's
//! record.
//!
//! ## Approval
//!
//! In production a submission lands `pending` and a provider or a human decides.
//! In development it is approved immediately, because otherwise no local build
//! could ever reach a tier that permits withdrawal and the whole payout path
//! would be untestable. That auto-approval is refused outside development — the
//! same guard shape as DEV_OTP_CODE.

use crate::error::{ApiError, ApiResult};
use crate::middleware::CurrentUser;
use crate::state::AppState;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use naivolt_auth::tier::KycTier;
use serde::{Deserialize, Serialize};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/kyc", get(status).post(submit))
}

// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KycStatusResponse {
    pub tier: i16,
    pub can_withdraw: bool,
    /// What the next tier unlocks, and what it costs to get there.
    pub next_step: Option<String>,
    /// Which document the next tier needs: `bvn` | `nin` | `address` | null.
    pub next_requirement: Option<&'static str>,
    /// Set while a submission is awaiting a decision, so the UI can show
    /// "we're checking" rather than offering the form again.
    pub pending: Option<PendingVerification>,
    pub daily_limit_ngn: String,
    /// Every tier and what it gives, so the screen can show the ladder rather
    /// than only the next rung.
    pub tiers: Vec<TierInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingVerification {
    pub target_tier: i16,
    pub status: String,
    pub submitted_at: String,
    pub rejection_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierInfo {
    pub tier: i16,
    pub name: &'static str,
    pub requirement: &'static str,
    /// "0" means withdrawal is not permitted at that tier.
    pub daily_limit_ngn: String,
}

fn tier_ladder() -> Vec<TierInfo> {
    [
        (KycTier::Tier0, "Unverified", "Nothing — you're here by default"),
        (KycTier::Tier1, "Verified", "Your BVN, name and date of birth"),
        (KycTier::Tier2, "Full", "Your NIN and a selfie"),
        (KycTier::Tier3, "Premium", "Proof of address"),
    ]
    .into_iter()
    .map(|(tier, name, requirement)| TierInfo {
        tier: tier.as_i16(),
        name,
        requirement,
        daily_limit_ngn: tier
            .daily_payout_cap()
            .map(|c| c.normalize().to_string())
            .unwrap_or_else(|| "0".into()),
    })
    .collect()
}

/// The document the next tier needs, as a token the client can branch on.
///
/// Returned alongside the prose `next_step` because a UI needs to pick a form,
/// and matching on an English sentence is how that breaks when the copy changes.
fn next_requirement(tier: KycTier) -> Option<&'static str> {
    match tier {
        KycTier::Tier0 => Some("bvn"),
        KycTier::Tier1 => Some("nin"),
        KycTier::Tier2 => Some("address"),
        KycTier::Tier3 => None,
    }
}

async fn status(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<KycStatusResponse>> {
    let tier_raw: i16 = sqlx::query_scalar("SELECT kyc_tier FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    let tier = KycTier::from_i16(tier_raw).unwrap_or(KycTier::Tier0);

    // The most recent submission that has not yet raised their tier.
    let pending: Option<(i16, String, chrono::DateTime<chrono::Utc>, Option<String>)> =
        sqlx::query_as(
            "SELECT target_tier, status, created_at, rejection_reason
               FROM kyc_verifications
              WHERE user_id = $1 AND status IN ('pending', 'manual_review', 'rejected')
              ORDER BY created_at DESC
              LIMIT 1",
        )
        .bind(user.id)
        .fetch_optional(&state.db)
        .await?;

    Ok(Json(KycStatusResponse {
        tier: tier_raw,
        can_withdraw: tier.can_withdraw(),
        next_step: tier.next_step().map(str::to_owned),
        next_requirement: next_requirement(tier),
        pending: pending.map(|(target_tier, status, submitted_at, rejection_reason)| {
            PendingVerification {
                target_tier,
                status,
                submitted_at: submitted_at.to_rfc3339(),
                rejection_reason,
            }
        }),
        daily_limit_ngn: tier
            .daily_payout_cap()
            .map(|c| c.normalize().to_string())
            .unwrap_or_else(|| "0".into()),
        tiers: tier_ladder(),
    }))
}

// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitKycBody {
    /// Full BVN or NIN. Never stored — only the last four digits are kept.
    pub id_number: String,
    /// Optional. Falls back to the name on the profile, which is where the app
    /// collects it — re-asking at every tier is how a two-tier journey turns
    /// into the same form three times.
    pub full_name: Option<String>,
    /// Optional, ISO date. Falls back to the profile.
    pub date_of_birth: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitKycResponse {
    pub status: String,
    pub tier: i16,
    pub message: String,
}

async fn submit(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<SubmitKycBody>,
) -> ApiResult<Json<SubmitKycResponse>> {
    let tier_raw: i16 = sqlx::query_scalar("SELECT kyc_tier FROM users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&state.db)
        .await?;
    let tier = KycTier::from_i16(tier_raw).unwrap_or(KycTier::Tier0);

    let Some(requirement) = next_requirement(tier) else {
        return Err(ApiError::BadRequest(
            "You're already fully verified.".into(),
        ));
    };

    // One in flight at a time. Without this, tapping submit twice queues two
    // reviews for the same person and a reviewer approves whichever they see.
    let already_pending: Option<i16> = sqlx::query_scalar(
        "SELECT target_tier FROM kyc_verifications
          WHERE user_id = $1 AND status IN ('pending', 'manual_review')",
    )
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;

    if already_pending.is_some() {
        return Err(ApiError::BadRequest(
            "We're already checking your details.".into(),
        ));
    }

    // Whatever the caller did not send comes from the profile.
    let (stored_name, stored_dob): (Option<String>, Option<chrono::NaiveDate>) =
        sqlx::query_as("SELECT display_name, date_of_birth FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_one(&state.db)
            .await?;

    let digits: String = body.id_number.chars().filter(char::is_ascii_digit).collect();
    // BVN and NIN are both 11 digits in Nigeria.
    if digits.len() != 11 {
        return Err(ApiError::BadRequest(format!(
            "A {} is 11 digits.",
            requirement.to_uppercase()
        )));
    }

    let full_name = body
        .full_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .or(stored_name)
        .ok_or_else(|| {
            ApiError::BadRequest("Add your full name in your profile first.".into())
        })?;

    if full_name.split_whitespace().count() < 2 {
        return Err(ApiError::BadRequest(
            "Enter your full name as it appears on your ID.".into(),
        ));
    }

    let dob = match body.date_of_birth.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(raw) => chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d")
            .map_err(|_| ApiError::BadRequest("Enter your date of birth as YYYY-MM-DD.".into()))?,
        None => stored_dob.ok_or_else(|| {
            ApiError::BadRequest("Add your date of birth in your profile first.".into())
        })?,
    };

    // 18 is the floor for holding a bank account in Nigeria, so anyone below it
    // could never receive a payout regardless of what we verify.
    let age_years = (chrono::Utc::now().date_naive() - dob).num_days() / 365;
    if age_years < 18 {
        return Err(ApiError::BadRequest(
            "You must be 18 or older to verify.".into(),
        ));
    }

    let target_tier = tier_raw + 1;
    let last4 = &digits[digits.len() - 4..];

    // Development approves immediately so the payout path is testable locally.
    // Anywhere else this waits for a provider or a human.
    let auto_approve = state.auto_approve_kyc;
    let status = if auto_approve { "approved" } else { "pending" };

    let mut tx = state.db.begin().await.map_err(anyhow::Error::from)?;

    let (bvn_last4, nin_last4) = match requirement {
        "bvn" => (Some(last4), None),
        "nin" => (None, Some(last4)),
        _ => (None, None),
    };

    sqlx::query(
        "INSERT INTO kyc_verifications
           (user_id, target_tier, provider, status, bvn_last4, nin_last4, full_name,
            date_of_birth, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(user.id)
    .bind(target_tier)
    .bind(if auto_approve { "dev" } else { "manual" })
    .bind(status)
    .bind(bvn_last4)
    .bind(nin_last4)
    .bind(&full_name)
    .bind(dob)
    .bind(auto_approve.then(chrono::Utc::now))
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    // Anything supplied here also lands on the profile: verifying once should
    // leave the account more complete, not just the submission.
    sqlx::query(
        "UPDATE users
            SET display_name  = COALESCE(display_name, $1),
                date_of_birth = COALESCE(date_of_birth, $2)
          WHERE id = $3",
    )
    .bind(&full_name)
    .bind(dob)
    .bind(user.id)
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    let new_tier = if auto_approve {
        // The database enforces that this cannot run without the approved row
        // above — see assert_tier_is_earned().
        sqlx::query("UPDATE users SET kyc_tier = $1 WHERE id = $2")
            .bind(target_tier)
            .bind(user.id)
            .execute(&mut *tx)
            .await
            .map_err(anyhow::Error::from)?;
        target_tier
    } else {
        tier_raw
    };

    tx.commit().await.map_err(anyhow::Error::from)?;

    Ok(Json(SubmitKycResponse {
        status: status.to_owned(),
        tier: new_tier,
        message: if auto_approve {
            "You're verified.".into()
        } else {
            "We're checking your details. This usually takes a few minutes.".into()
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tier_names_the_document_it_needs() {
        // The client picks a form from this token, so a gap here is a screen
        // that cannot be built.
        assert_eq!(next_requirement(KycTier::Tier0), Some("bvn"));
        assert_eq!(next_requirement(KycTier::Tier1), Some("nin"));
        assert_eq!(next_requirement(KycTier::Tier2), Some("address"));
        assert_eq!(next_requirement(KycTier::Tier3), None);
    }

    #[test]
    fn the_ladder_covers_every_tier_and_only_tier_zero_cannot_withdraw() {
        let ladder = tier_ladder();
        assert_eq!(ladder.len(), 4);
        assert_eq!(ladder[0].daily_limit_ngn, "0");
        for rung in &ladder[1..] {
            assert_ne!(rung.daily_limit_ngn, "0", "tier {} should allow withdrawal", rung.tier);
        }
    }

    #[test]
    fn limits_increase_with_every_tier() {
        let ladder = tier_ladder();
        let limits: Vec<f64> = ladder
            .iter()
            .map(|t| t.daily_limit_ngn.parse().unwrap())
            .collect();
        for pair in limits.windows(2) {
            assert!(pair[1] > pair[0], "a higher tier must raise the limit");
        }
    }
}
