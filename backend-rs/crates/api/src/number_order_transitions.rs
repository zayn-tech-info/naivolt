use crate::error::{ApiError, ApiResult};
use crate::number_provider::{ActivationCheck, ActivationLifecycle, Sms};
use crate::payout_routes::{lock_user_ngn_account, platform_account};
use naivolt_core::Asset;
use naivolt_ledger::journal::JournalBuilder;
use naivolt_ledger::{AccountKind, JournalKind};
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub(crate) enum OrderTransition {
    Deliver {
        code: String,
        text: String,
    },
    Refund {
        status: RefundStatus,
        reason: String,
    },
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum RefundStatus {
    Failed,
    Expired,
    Cancelled,
}

impl RefundStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Failed => "failed",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TransitionOutcome {
    Applied,
    AlreadyTerminal(String),
}

type LockedOrder = (
    Uuid,
    Decimal,
    String,
    String,
    Option<Uuid>,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<String>,
);

pub(crate) async fn apply(
    db: &PgPool,
    order_id: Uuid,
    transition: OrderTransition,
) -> ApiResult<TransitionOutcome> {
    apply_inner(db, order_id, transition, None, &[]).await
}

pub(crate) async fn apply_claimed(
    db: &PgPool,
    order_id: Uuid,
    claim_token: Uuid,
    transition: OrderTransition,
) -> ApiResult<TransitionOutcome> {
    apply_inner(db, order_id, transition, Some(claim_token), &[]).await
}

pub(crate) async fn deliver(
    db: &PgPool,
    order_id: Uuid,
    code: String,
    text: String,
    messages: &[Sms],
) -> ApiResult<TransitionOutcome> {
    apply_check(db, order_id, None, check_from_legacy_deliver(code, text, messages)).await
}

pub(crate) async fn deliver_claimed(
    db: &PgPool,
    order_id: Uuid,
    claim_token: Uuid,
    code: String,
    text: String,
    messages: &[Sms],
) -> ApiResult<TransitionOutcome> {
    apply_check(
        db,
        order_id,
        Some(claim_token),
        check_from_legacy_deliver(code, text, messages),
    )
    .await
}

fn check_from_legacy_deliver(code: String, text: String, messages: &[Sms]) -> ActivationCheck {
    let messages = if messages.is_empty() && !code.is_empty() {
        vec![Sms {
            sender: None,
            text,
            code: Some(code),
            received_at: None,
            provider_message_id: None,
        }]
    } else {
        messages.to_vec()
    };
    ActivationCheck::open().with_messages(messages)
}

pub(crate) async fn apply_check(
    db: &PgPool,
    order_id: Uuid,
    claim_token: Option<Uuid>,
    check: ActivationCheck,
) -> ApiResult<TransitionOutcome> {
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    let row: Option<(
        Uuid,
        Decimal,
        String,
        String,
        Option<Uuid>,
        Option<chrono::DateTime<chrono::Utc>>,
        Option<String>,
        bool,
        Option<chrono::DateTime<chrono::Utc>>,
        chrono::DateTime<chrono::Utc>,
    )> = sqlx::query_as(
        "SELECT user_id, price_ngn, reference, status, reconcile_claim_token, reconcile_claimed_until,
                provider_order_id, activation_open, expires_at, created_at
           FROM number_orders
          WHERE id = $1
          FOR UPDATE",
    )
    .bind(order_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    let (
        user_id,
        price_ngn,
        reference,
        current_status,
        stored_token,
        claimed_until,
        provider_order_id,
        _activation_open,
        mut expires_at,
        created_at,
    ) = row.ok_or(ApiError::NotFound)?;

    if let Some(token) = claim_token {
        if stored_token != Some(token)
            || claimed_until.map_or(true, |until| until <= chrono::Utc::now())
        {
            return Err(ApiError::Conflict(
                "The reconciliation claim is no longer current.".into(),
            ));
        }
    }

    if matches!(
        current_status.as_str(),
        "cancelled" | "expired" | "failed"
    ) {
        tx.commit().await.map_err(anyhow::Error::from)?;
        return Ok(TransitionOutcome::AlreadyTerminal(current_status));
    }

    if let Some(newer) = check.expires_at {
        if expires_at.map_or(true, |current| newer > current) {
            sqlx::query("UPDATE number_orders SET expires_at = $2, updated_at = now() WHERE id = $1")
                .bind(order_id)
                .bind(newer)
                .execute(&mut *tx)
                .await
                .map_err(anyhow::Error::from)?;
            expires_at = Some(newer);
        }
    }

    let expired = expires_at.is_some_and(|expiry| expiry <= chrono::Utc::now());

    if !check.messages.is_empty() {
        let provider_order_id = provider_order_id.as_deref().ok_or_else(|| {
            ApiError::Internal(anyhow::anyhow!("delivery has no provider order"))
        })?;
        insert_messages(&mut tx, order_id, provider_order_id, &check.messages).await?;
    }

    let qualifying: Option<(String, String)> = sqlx::query_as(
        "SELECT code, text FROM number_messages
          WHERE order_id = $1 AND code IS NOT NULL AND length(btrim(code)) > 0
          ORDER BY received_at ASC, id ASC
          LIMIT 1",
    )
    .bind(order_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    let money_open = matches!(
        current_status.as_str(),
        "reserved" | "awaiting_code" | "review_required"
    );
    let stay_open = check.lifecycle == ActivationLifecycle::Open && !expired;

    if money_open {
        if let Some((code, text)) = qualifying {
            return settle_open(
                tx,
                order_id,
                user_id,
                price_ngn,
                reference,
                current_status,
                code,
                text,
                stay_open,
                created_at,
            )
            .await;
        }
        if check.lifecycle == ActivationLifecycle::Closed || expired {
            let reason = if check.lifecycle == ActivationLifecycle::Closed {
                "supplier_finished"
            } else {
                "expired"
            };
            return refund_open(
                tx,
                order_id,
                user_id,
                price_ngn,
                reference,
                RefundStatus::Expired,
                reason,
            )
            .await;
        }
        schedule_open(&mut tx, order_id, created_at, true).await?;
        tx.commit().await.map_err(anyhow::Error::from)?;
        return Ok(TransitionOutcome::Applied);
    }

    if current_status == "delivered" {
        schedule_open(&mut tx, order_id, created_at, stay_open).await?;
        tx.commit().await.map_err(anyhow::Error::from)?;
        return Ok(TransitionOutcome::Applied);
    }

    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(TransitionOutcome::AlreadyTerminal(current_status))
}

async fn insert_messages(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    order_id: Uuid,
    provider_order_id: &str,
    messages: &[Sms],
) -> ApiResult<()> {
    for message in messages {
        sqlx::query(
            "INSERT INTO number_messages (order_id, sender, text, code, received_at, provider_message_key)
             VALUES (
                $1, $2, $3, $4, COALESCE($5, now()),
                COALESCE(
                    CASE WHEN $7::text IS NOT NULL AND length($7) > 0 THEN 'sid:' || $7 END,
                    encode(digest(
                        CASE WHEN $5::timestamptz IS NULL
                             THEN jsonb_build_array($6::text, $2::text, $3::text, $4::text)::text
                             ELSE jsonb_build_array($6::text, $2::text, $3::text, $4::text, $5::timestamptz)::text
                        END,
                    'sha256'), 'hex')
                )
             )
             ON CONFLICT (order_id, provider_message_key) WHERE provider_message_key IS NOT NULL DO NOTHING",
        )
        .bind(order_id)
        .bind(message.sender.as_deref())
        .bind(&message.text)
        .bind(message.code.as_deref())
        .bind(message.received_at)
        .bind(provider_order_id)
        .bind(message.provider_message_id.as_deref())
        .execute(&mut **tx)
        .await
        .map_err(anyhow::Error::from)?;
    }
    Ok(())
}

async fn schedule_open(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    order_id: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    open: bool,
) -> ApiResult<()> {
    let delay = if chrono::Utc::now() - created_at < chrono::Duration::minutes(5) {
        10_i64
    } else {
        30
    };
    sqlx::query(
        "UPDATE number_orders
            SET activation_open = $2,
                reconcile_next_at = CASE WHEN $2 THEN LEAST(COALESCE(expires_at, now() + interval '15 minutes'), now() + ($3 * interval '1 second')) ELSE NULL END,
                reconcile_claim_token = NULL,
                reconcile_claimed_until = NULL,
                reconcile_last_checked_at = now(),
                reconcile_attempt_count = 0,
                updated_at = now()
          WHERE id = $1",
    )
    .bind(order_id)
    .bind(open)
    .bind(delay)
    .execute(&mut **tx)
    .await
    .map_err(anyhow::Error::from)?;
    Ok(())
}

async fn settle_open(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    order_id: Uuid,
    _user_id: Uuid,
    price_ngn: Decimal,
    reference: String,
    current_status: String,
    code: String,
    text: String,
    stay_open: bool,
    created_at: chrono::DateTime<chrono::Utc>,
) -> ApiResult<TransitionOutcome> {
    if current_status == "delivered" {
        schedule_open(&mut tx, order_id, created_at, stay_open).await?;
        tx.commit().await.map_err(anyhow::Error::from)?;
        return Ok(TransitionOutcome::Applied);
    }
    let pending = platform_account(&mut tx, AccountKind::NumberPayablePending).await?;
    let revenue = platform_account(&mut tx, AccountKind::NumberRevenue).await?;
    let journal = JournalBuilder::new(
        JournalKind::NumberSettle,
        reference.clone(),
        format!("{reference}:settle"),
    )
    .entry(
        pending,
        AccountKind::NumberPayablePending,
        Asset::Ngn,
        price_ngn,
    )
    .entry(revenue, AccountKind::NumberRevenue, Asset::Ngn, -price_ngn)
    .build()
    .map_err(|error| ApiError::Internal(anyhow::anyhow!(error)))?;
    let posted = journal
        .post(&mut tx)
        .await
        .map_err(|error| ApiError::Internal(anyhow::anyhow!(error)))?;
    let delay = if chrono::Utc::now() - created_at < chrono::Duration::minutes(5) {
        10_i64
    } else {
        30
    };
    sqlx::query(
        "UPDATE number_orders
            SET status = 'delivered',
                sms_code = COALESCE(sms_code, $3),
                sms_text = COALESCE(sms_text, $4),
                received_at = COALESCE(received_at, now()),
                settled_journal_id = $5,
                activation_open = $2,
                reconcile_next_at = CASE WHEN $2 THEN now() + ($6 * interval '1 second') ELSE NULL END,
                reconcile_claim_token = NULL,
                reconcile_claimed_until = NULL,
                updated_at = now()
          WHERE id = $1 AND status IN ('reserved', 'awaiting_code', 'review_required')",
    )
    .bind(order_id)
    .bind(stay_open)
    .bind(&code)
    .bind(&text)
    .bind(posted.journal_id())
    .bind(delay)
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    tracing::info!(order = %reference, transition = "deliver", status = "delivered", outcome = "applied", "number order transition completed");
    Ok(TransitionOutcome::Applied)
}

async fn refund_open(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    order_id: Uuid,
    user_id: Uuid,
    price_ngn: Decimal,
    reference: String,
    status: RefundStatus,
    reason: &str,
) -> ApiResult<TransitionOutcome> {
    if reason.trim().is_empty() {
        return Err(ApiError::Internal(anyhow::anyhow!("refund reason is empty")));
    }
    let user_account = lock_user_ngn_account(&mut tx, user_id).await?;
    let pending = platform_account(&mut tx, AccountKind::NumberPayablePending).await?;
    let journal = JournalBuilder::new(
        JournalKind::NumberRefund,
        reference.clone(),
        format!("{reference}:refund"),
    )
    .entry(
        pending,
        AccountKind::NumberPayablePending,
        Asset::Ngn,
        price_ngn,
    )
    .entry(user_account, AccountKind::UserNgn, Asset::Ngn, -price_ngn)
    .metadata(serde_json::json!({ "reason": reason }))
    .build()
    .map_err(|error| ApiError::Internal(anyhow::anyhow!(error)))?;
    let posted = journal
        .post(&mut tx)
        .await
        .map_err(|error| ApiError::Internal(anyhow::anyhow!(error)))?;
    sqlx::query(
        "UPDATE number_orders
            SET status = $2,
                failure_reason = $3,
                refunded_journal_id = $4,
                activation_open = false,
                reconcile_next_at = NULL,
                reconcile_claim_token = NULL,
                reconcile_claimed_until = NULL,
                updated_at = now()
          WHERE id = $1 AND status IN ('reserved', 'awaiting_code', 'review_required')",
    )
    .bind(order_id)
    .bind(status.as_str())
    .bind(reason)
    .bind(posted.journal_id())
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    tracing::info!(order = %reference, transition = status.as_str(), status = status.as_str(), outcome = "applied", "number order transition completed");
    Ok(TransitionOutcome::Applied)
}

async fn apply_inner(
    db: &PgPool,
    order_id: Uuid,
    transition: OrderTransition,
    claim_token: Option<Uuid>,
    messages: &[Sms],
) -> ApiResult<TransitionOutcome> {
    let requested = match &transition {
        OrderTransition::Deliver { .. } => "deliver",
        OrderTransition::Refund { status, .. } => status.as_str(),
    };
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    let row: Option<LockedOrder> = sqlx::query_as(
        "SELECT user_id, price_ngn, reference, status, reconcile_claim_token, reconcile_claimed_until, provider_order_id
           FROM number_orders
          WHERE id = $1
          FOR UPDATE",
    )
    .bind(order_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    let (
        user_id,
        price_ngn,
        reference,
        current_status,
        stored_token,
        claimed_until,
        provider_order_id,
    ) = row.ok_or(ApiError::NotFound)?;
    if let Some(token) = claim_token {
        if stored_token != Some(token)
            || claimed_until.map_or(true, |until| until <= chrono::Utc::now())
        {
            return Err(ApiError::Conflict(
                "The reconciliation claim is no longer current.".into(),
            ));
        }
    }
    if !matches!(
        current_status.as_str(),
        "reserved" | "awaiting_code" | "review_required"
    ) {
        tx.commit().await.map_err(anyhow::Error::from)?;
        tracing::info!(order = %reference, transition = requested, status = %current_status, outcome = "replayed", "number order transition completed");
        return Ok(TransitionOutcome::AlreadyTerminal(current_status));
    }

    if !messages.is_empty() {
        let provider_order_id = provider_order_id
            .as_deref()
            .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("delivery has no provider order")))?;
        for message in messages {
            sqlx::query(
                "INSERT INTO number_messages (order_id, sender, text, code, received_at, provider_message_key)
                 VALUES (
                    $1, $2, $3, $4, COALESCE($5, now()),
                    COALESCE(
                        CASE WHEN $7::text IS NOT NULL AND length($7) > 0 THEN 'sid:' || $7 END,
                        encode(digest(
                            CASE WHEN $5::timestamptz IS NULL
                                 THEN jsonb_build_array($6::text, $2::text, $3::text, $4::text)::text
                                 ELSE jsonb_build_array($6::text, $2::text, $3::text, $4::text, $5::timestamptz)::text
                            END,
                        'sha256'), 'hex')
                    )
                 )
                 ON CONFLICT (order_id, provider_message_key) WHERE provider_message_key IS NOT NULL DO NOTHING")
                .bind(order_id).bind(message.sender.as_deref()).bind(&message.text)
                .bind(message.code.as_deref()).bind(message.received_at).bind(provider_order_id)
                .bind(message.provider_message_id.as_deref())
                .execute(&mut *tx).await.map_err(anyhow::Error::from)?;
        }
    }

    let (journal, next_status, reason, code, text) = match transition {
        OrderTransition::Deliver { code, text } => {
            let pending = platform_account(&mut tx, AccountKind::NumberPayablePending).await?;
            let revenue = platform_account(&mut tx, AccountKind::NumberRevenue).await?;
            let journal = JournalBuilder::new(
                JournalKind::NumberSettle,
                reference.clone(),
                format!("{reference}:settle"),
            )
            .entry(
                pending,
                AccountKind::NumberPayablePending,
                Asset::Ngn,
                price_ngn,
            )
            .entry(revenue, AccountKind::NumberRevenue, Asset::Ngn, -price_ngn)
            .build()
            .map_err(|error| ApiError::Internal(anyhow::anyhow!(error)))?;
            (journal, "delivered", None, Some(code), Some(text))
        }
        OrderTransition::Refund { status, reason } => {
            if reason.trim().is_empty() {
                return Err(ApiError::Internal(anyhow::anyhow!(
                    "refund reason is empty"
                )));
            }
            let user_account = lock_user_ngn_account(&mut tx, user_id).await?;
            let pending = platform_account(&mut tx, AccountKind::NumberPayablePending).await?;
            let journal = JournalBuilder::new(
                JournalKind::NumberRefund,
                reference.clone(),
                format!("{reference}:refund"),
            )
            .entry(
                pending,
                AccountKind::NumberPayablePending,
                Asset::Ngn,
                price_ngn,
            )
            .entry(user_account, AccountKind::UserNgn, Asset::Ngn, -price_ngn)
            .metadata(serde_json::json!({ "reason": reason.clone() }))
            .build()
            .map_err(|error| ApiError::Internal(anyhow::anyhow!(error)))?;
            (journal, status.as_str(), Some(reason), None, None)
        }
    };

    let posted = journal
        .post(&mut tx)
        .await
        .map_err(|error| ApiError::Internal(anyhow::anyhow!(error)))?;

    let result = sqlx::query(
        "UPDATE number_orders
            SET status = $2,
                failure_reason = $3,
                sms_code = COALESCE($4, sms_code),
                sms_text = COALESCE($5, sms_text),
                received_at = CASE WHEN $2 = 'delivered' THEN now() ELSE received_at END,
                settled_journal_id = CASE WHEN $2 = 'delivered' THEN $6 ELSE settled_journal_id END,
                refunded_journal_id = CASE WHEN $2 <> 'delivered' THEN $6 ELSE refunded_journal_id END,
                activation_open = ($2 = 'delivered'),
                reconcile_next_at = NULL,
                reconcile_claim_token = NULL,
                reconcile_claimed_until = NULL,
                updated_at = now()
          WHERE id = $1 AND status IN ('reserved', 'awaiting_code', 'review_required')",
    )
    .bind(order_id)
    .bind(next_status)
    .bind(reason.as_deref())
    .bind(code.as_deref())
    .bind(text.as_deref())
    .bind(posted.journal_id())
    .execute(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    if result.rows_affected() != 1 {
        return Err(ApiError::Internal(anyhow::anyhow!(
            "number order transition updated {} rows",
            result.rows_affected()
        )));
    }

    tx.commit().await.map_err(anyhow::Error::from)?;
    tracing::info!(order = %reference, transition = requested, status = next_status, outcome = "applied", "number order transition completed");
    Ok(TransitionOutcome::Applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_database::IsolatedDatabase;
    use sqlx::Executor;

    async fn seeded_order(pool: &PgPool, suffix: &str) -> Uuid {
        let user_id: Uuid =
            sqlx::query_scalar("INSERT INTO users (email) VALUES ($1) RETURNING id")
                .bind(format!("transition-{suffix}@example.test"))
                .fetch_one(pool)
                .await
                .unwrap();
        let user_account: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_accounts (kind, user_id, asset)
             VALUES ('user_ngn', $1, 'NGN') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap();
        let pending: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_accounts (kind, asset) VALUES ('number_payable_pending', 'NGN')
             ON CONFLICT DO NOTHING RETURNING id",
        )
        .fetch_optional(pool)
        .await
        .unwrap()
        .unwrap_or_else(Uuid::nil);
        let pending = if pending.is_nil() {
            sqlx::query_scalar(
                "SELECT id FROM ledger_accounts WHERE kind = 'number_payable_pending' AND asset = 'NGN'",
            )
            .fetch_one(pool)
            .await
            .unwrap()
        } else {
            pending
        };
        pool.execute(
            "INSERT INTO ledger_accounts (kind, asset) VALUES ('number_revenue', 'NGN')
             ON CONFLICT DO NOTHING",
        )
        .await
        .unwrap();

        let reference = format!("NVNO-{suffix}");
        let reserve_id: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_journals (kind, reference, idempotency_key)
             VALUES ('number_reserve', $1, $2) RETURNING id",
        )
        .bind(&reference)
        .bind(format!("reserve-{suffix}"))
        .fetch_one(pool)
        .await
        .unwrap();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(
            "INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
             VALUES ($1, $2, 'NGN', 500), ($1, $3, 'NGN', -500)",
        )
        .bind(reserve_id)
        .bind(user_account)
        .bind(pending)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();

        sqlx::query_scalar(
            "INSERT INTO number_orders (
                user_id, product_id, country_id, price_ngn, status, reference,
                reserved_journal_id, idempotency_key, idempotency_payload_complete
             )
             SELECT $1, p.id, c.id, 500, 'awaiting_code', $2, $3, $4, true
               FROM number_products p, number_countries c
              ORDER BY p.id, c.id LIMIT 1
             RETURNING id",
        )
        .bind(user_id)
        .bind(reference)
        .bind(reserve_id)
        .bind(Uuid::new_v4())
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn concurrent_terminal_transitions_commit_once() {
        let database = IsolatedDatabase::new("number_transition_test").await;
        let pool = database.pool.clone();
        let order_id = seeded_order(&pool, "RACE").await;

        let delivery = apply(
            &pool,
            order_id,
            OrderTransition::Deliver {
                code: "123456".into(),
                text: "code 123456".into(),
            },
        );
        let refund = apply(
            &pool,
            order_id,
            OrderTransition::Refund {
                status: RefundStatus::Cancelled,
                reason: "cancelled".into(),
            },
        );
        let (left, right) = tokio::join!(delivery, refund);
        let outcomes = [left.unwrap(), right.unwrap()];
        assert_eq!(
            outcomes
                .iter()
                .filter(|o| **o == TransitionOutcome::Applied)
                .count(),
            1
        );

        let (status, settlements, refunds): (String, i64, i64) = sqlx::query_as(
            "SELECT status,
                    (CASE WHEN settled_journal_id IS NOT NULL THEN 1 ELSE 0 END)::BIGINT,
                    (CASE WHEN refunded_journal_id IS NOT NULL THEN 1 ELSE 0 END)::BIGINT
               FROM number_orders WHERE id = $1",
        )
        .bind(order_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(matches!(status.as_str(), "delivered" | "cancelled"));
        assert_eq!(settlements + refunds, 1);

        let terminal_journals: i64 = sqlx::query_scalar(
            "SELECT count(*)
               FROM ledger_journals j
               JOIN number_orders o ON o.reference = j.reference
              WHERE o.id = $1 AND j.kind IN ('number_settle', 'number_refund')",
        )
        .bind(order_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(terminal_journals, 1);

        let delivery_order = seeded_order(&pool, "DELIVERY").await;
        let first = apply(
            &pool,
            delivery_order,
            OrderTransition::Deliver {
                code: "111111".into(),
                text: "first delivery".into(),
            },
        );
        let second = apply(
            &pool,
            delivery_order,
            OrderTransition::Deliver {
                code: "222222".into(),
                text: "second delivery".into(),
            },
        );
        let (first, second) = tokio::join!(first, second);
        let outcomes = [first.unwrap(), second.unwrap()];
        assert_eq!(
            outcomes
                .iter()
                .filter(|o| **o == TransitionOutcome::Applied)
                .count(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM ledger_journals j
                  JOIN number_orders o ON o.reference = j.reference
                 WHERE o.id = $1 AND j.kind = 'number_settle'",
            )
            .bind(delivery_order)
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );

        let refund_order = seeded_order(&pool, "REFUND").await;
        let first = apply(
            &pool,
            refund_order,
            OrderTransition::Refund {
                status: RefundStatus::Cancelled,
                reason: "first cancellation".into(),
            },
        );
        let second = apply(
            &pool,
            refund_order,
            OrderTransition::Refund {
                status: RefundStatus::Cancelled,
                reason: "second cancellation".into(),
            },
        );
        let (first, second) = tokio::join!(first, second);
        let outcomes = [first.unwrap(), second.unwrap()];
        assert_eq!(
            outcomes
                .iter()
                .filter(|o| **o == TransitionOutcome::Applied)
                .count(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM ledger_journals j
                  JOIN number_orders o ON o.reference = j.reference
                 WHERE o.id = $1 AND j.kind = 'number_refund'",
            )
            .bind(refund_order)
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );

        let expiry_order = seeded_order(&pool, "EXPIRY").await;
        let delivery = apply(
            &pool,
            expiry_order,
            OrderTransition::Deliver {
                code: "333333".into(),
                text: "delivery racing expiry".into(),
            },
        );
        let expiry = apply(
            &pool,
            expiry_order,
            OrderTransition::Refund {
                status: RefundStatus::Expired,
                reason: "expired".into(),
            },
        );
        let (delivery, expiry) = tokio::join!(delivery, expiry);
        let outcomes = [delivery.unwrap(), expiry.unwrap()];
        assert_eq!(
            outcomes
                .iter()
                .filter(|o| **o == TransitionOutcome::Applied)
                .count(),
            1
        );

        let unbalanced_terminal_journals: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM (
                 SELECT j.id
                   FROM ledger_journals j
                   JOIN number_orders o ON o.reference = j.reference
                   JOIN ledger_entries e ON e.journal_id = j.id
                  WHERE o.reference LIKE 'NVNO-%'
                    AND j.kind IN ('number_settle', 'number_refund')
                  GROUP BY j.id, e.asset
                 HAVING sum(e.amount) <> 0
             ) invalid",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(unbalanced_terminal_journals, 0);

        let construction_failure = seeded_order(&pool, "BUILDFAIL").await;
        assert!(apply(
            &pool,
            construction_failure,
            OrderTransition::Refund {
                status: RefundStatus::Failed,
                reason: "   ".into(),
            },
        )
        .await
        .is_err());

        pool.execute(
            "CREATE FUNCTION reject_number_order_update() RETURNS trigger AS $$
             BEGIN RAISE EXCEPTION 'injected order update failure'; END; $$ LANGUAGE plpgsql;
             CREATE TRIGGER reject_number_order_update
             BEFORE UPDATE ON number_orders FOR EACH ROW
             EXECUTE FUNCTION reject_number_order_update()",
        )
        .await
        .unwrap();
        let update_failure = seeded_order(&pool, "UPDATEFAIL").await;
        assert!(apply(
            &pool,
            update_failure,
            OrderTransition::Deliver {
                code: "444444".into(),
                text: "injected update failure".into(),
            },
        )
        .await
        .is_err());
        pool.execute(
            "DROP TRIGGER reject_number_order_update ON number_orders;
             DROP FUNCTION reject_number_order_update()",
        )
        .await
        .unwrap();
        assert_eq!(terminal_journal_count(&pool, update_failure).await, 0);

        pool.execute(
            "CREATE FUNCTION reject_number_order_commit() RETURNS trigger AS $$
             BEGIN RAISE EXCEPTION 'injected commit failure'; END; $$ LANGUAGE plpgsql;
             CREATE CONSTRAINT TRIGGER reject_number_order_commit
             AFTER UPDATE ON number_orders DEFERRABLE INITIALLY DEFERRED
             FOR EACH ROW EXECUTE FUNCTION reject_number_order_commit()",
        )
        .await
        .unwrap();
        let commit_failure = seeded_order(&pool, "COMMITFAIL").await;
        assert!(apply(
            &pool,
            commit_failure,
            OrderTransition::Deliver {
                code: "555555".into(),
                text: "injected commit failure".into(),
            },
        )
        .await
        .is_err());
        pool.execute(
            "DROP TRIGGER reject_number_order_commit ON number_orders;
             DROP FUNCTION reject_number_order_commit()",
        )
        .await
        .unwrap();
        assert_eq!(terminal_journal_count(&pool, commit_failure).await, 0);

        let uncertain_ack = seeded_order(&pool, "ACK").await;
        assert_eq!(
            apply(
                &pool,
                uncertain_ack,
                OrderTransition::Deliver {
                    code: "666666".into(),
                    text: "committed before acknowledgement".into(),
                },
            )
            .await
            .unwrap(),
            TransitionOutcome::Applied
        );
        assert_eq!(
            apply(
                &pool,
                uncertain_ack,
                OrderTransition::Refund {
                    status: RefundStatus::Failed,
                    reason: "retry after uncertain acknowledgement".into(),
                },
            )
            .await
            .unwrap(),
            TransitionOutcome::AlreadyTerminal("delivered".into())
        );
        assert_eq!(terminal_journal_count(&pool, uncertain_ack).await, 1);

        database.cleanup().await;
    }

    async fn terminal_journal_count(pool: &PgPool, order_id: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM ledger_journals j
              JOIN number_orders o ON o.reference = j.reference
             WHERE o.id = $1 AND j.kind IN ('number_settle', 'number_refund')",
        )
        .bind(order_id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn claimed_delivery_keeps_distinct_supplier_timestamps_and_deduplicates_replays() {
        let database = IsolatedDatabase::new("number_message_identity_test").await;
        let pool = database.pool.clone();
        let order_id = seeded_order(&pool, "MESSAGES").await;
        let token = Uuid::new_v4();
        sqlx::query("UPDATE number_orders SET provider_order_id='provider-1' WHERE id=$1")
            .bind(order_id).execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/staged/0018_close_number_reconciliation.sql"))
            .execute(&pool).await.unwrap();
        sqlx::query("UPDATE number_orders SET reconcile_claim_token=$2, reconcile_claimed_until=now()+interval '60 seconds' WHERE id=$1")
            .bind(order_id).bind(token).execute(&pool).await.unwrap();
        let first_at = chrono::Utc::now() - chrono::Duration::seconds(1);
        let second_at = chrono::Utc::now();
        let messages = vec![
            Sms { sender: Some("service".into()), text: "same text".into(), code: Some("123".into()), received_at: Some(first_at), provider_message_id: None },
            Sms { sender: Some("service".into()), text: "same text".into(), code: Some("123".into()), received_at: Some(second_at), provider_message_id: None },
            Sms { sender: Some("service".into()), text: "same text".into(), code: Some("123".into()), received_at: Some(second_at), provider_message_id: None },
        ];
        deliver_claimed(&pool, order_id, token, "123".into(), "same text".into(), &messages).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM number_messages WHERE order_id=$1")
            .bind(order_id).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 2);
        let status: String = sqlx::query_scalar("SELECT status FROM number_orders WHERE id=$1")
            .bind(order_id).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "delivered");
        database.cleanup().await;
    }

    #[tokio::test]
    async fn duplicate_supplier_texts_settle_without_the_closing_migration() {
        let database = IsolatedDatabase::new("number_message_text_unique_test").await;
        let pool = database.pool.clone();
        let order_id = seeded_order(&pool, "DUPTEXT").await;
        sqlx::query("UPDATE number_orders SET provider_order_id='provider-dup' WHERE id=$1")
            .bind(order_id)
            .execute(&pool)
            .await
            .unwrap();
        let first_at = chrono::Utc::now() - chrono::Duration::seconds(1);
        let second_at = chrono::Utc::now();
        let messages = vec![
            Sms {
                sender: Some("service".into()),
                text: "same text".into(),
                code: Some("123".into()),
                received_at: Some(first_at),
                provider_message_id: None,
            },
            Sms {
                sender: Some("service".into()),
                text: "same text".into(),
                code: Some("123".into()),
                received_at: Some(second_at),
                provider_message_id: None,
            },
        ];
        deliver(
            &pool,
            order_id,
            "123".into(),
            "same text".into(),
            &messages,
        )
        .await
        .unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM number_messages WHERE order_id=$1")
                .bind(order_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 2);
        let status: String = sqlx::query_scalar("SELECT status FROM number_orders WHERE id=$1")
            .bind(order_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "delivered");
        database.cleanup().await;
    }

    #[tokio::test]
    async fn text_only_sms_does_not_settle_until_a_code_arrives() {
        let database = IsolatedDatabase::new("number_text_only_settle_test").await;
        let pool = database.pool.clone();
        let order_id = seeded_order(&pool, "TEXTONLY").await;
        sqlx::query("UPDATE number_orders SET provider_order_id='provider-text' WHERE id=$1")
            .bind(order_id)
            .execute(&pool)
            .await
            .unwrap();
        apply_check(
            &pool,
            order_id,
            None,
            ActivationCheck::open().with_messages(vec![Sms {
                sender: Some("svc".into()),
                text: "hello".into(),
                code: None,
                received_at: None,
                provider_message_id: None,
            }]),
        )
        .await
        .unwrap();
        let (status, settled): (String, bool) = sqlx::query_as(
            "SELECT status, settled_journal_id IS NOT NULL FROM number_orders WHERE id=$1",
        )
        .bind(order_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "awaiting_code");
        assert!(!settled);
        apply_check(
            &pool,
            order_id,
            None,
            ActivationCheck::open().with_messages(vec![Sms {
                sender: Some("svc".into()),
                text: "code 999".into(),
                code: Some("999".into()),
                received_at: None,
                provider_message_id: None,
            }]),
        )
        .await
        .unwrap();
        let (status, code, journals): (String, Option<String>, i64) = sqlx::query_as(
            "SELECT o.status, o.sms_code,
                    (SELECT count(*) FROM ledger_journals j WHERE j.reference = o.reference AND j.kind = 'number_settle')
               FROM number_orders o WHERE o.id=$1",
        )
        .bind(order_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "delivered");
        assert_eq!(code.as_deref(), Some("999"));
        assert_eq!(journals, 1);
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM number_messages WHERE order_id=$1")
                .bind(order_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 2);
        database.cleanup().await;
    }

    #[tokio::test]
    async fn delivered_order_appends_later_sms_without_a_second_settle() {
        let database = IsolatedDatabase::new("number_append_after_deliver_test").await;
        let pool = database.pool.clone();
        let order_id = seeded_order(&pool, "APPEND").await;
        sqlx::query("UPDATE number_orders SET provider_order_id='provider-append' WHERE id=$1")
            .bind(order_id)
            .execute(&pool)
            .await
            .unwrap();
        apply_check(
            &pool,
            order_id,
            None,
            ActivationCheck::open().with_messages(vec![Sms {
                sender: None,
                text: "111".into(),
                code: Some("111".into()),
                received_at: None,
                provider_message_id: Some("a".into()),
            }]),
        )
        .await
        .unwrap();
        apply_check(
            &pool,
            order_id,
            None,
            ActivationCheck::open().with_messages(vec![
                Sms {
                    sender: None,
                    text: "111".into(),
                    code: Some("111".into()),
                    received_at: None,
                    provider_message_id: Some("a".into()),
                },
                Sms {
                    sender: None,
                    text: "222".into(),
                    code: Some("222".into()),
                    received_at: None,
                    provider_message_id: Some("b".into()),
                },
            ]),
        )
        .await
        .unwrap();
        apply_check(
            &pool,
            order_id,
            None,
            ActivationCheck::closed().with_messages(vec![Sms {
                sender: None,
                text: "222".into(),
                code: Some("222".into()),
                received_at: None,
                provider_message_id: Some("b".into()),
            }]),
        )
        .await
        .unwrap();
        let (status, open, settles, code): (String, bool, i64, Option<String>) = sqlx::query_as(
            "SELECT o.status, o.activation_open,
                    (SELECT count(*) FROM ledger_journals j WHERE j.reference = o.reference AND j.kind = 'number_settle'),
                    o.sms_code
               FROM number_orders o WHERE o.id=$1",
        )
        .bind(order_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "delivered");
        assert!(!open);
        assert_eq!(settles, 1);
        assert_eq!(code.as_deref(), Some("111"));
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM number_messages WHERE order_id=$1")
                .bind(order_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 2);
        database.cleanup().await;
    }

    #[tokio::test]
    async fn missing_supplier_time_does_not_duplicate_equal_content() {
        let database = IsolatedDatabase::new("number_stable_key_test").await;
        let pool = database.pool.clone();
        let order_id = seeded_order(&pool, "NOTIME").await;
        sqlx::query("UPDATE number_orders SET provider_order_id='provider-notime' WHERE id=$1")
            .bind(order_id)
            .execute(&pool)
            .await
            .unwrap();
        let sms = Sms {
            sender: Some("svc".into()),
            text: "same".into(),
            code: Some("1".into()),
            received_at: None,
            provider_message_id: None,
        };
        apply_check(
            &pool,
            order_id,
            None,
            ActivationCheck::open().with_messages(vec![sms.clone()]),
        )
        .await
        .unwrap();
        apply_check(
            &pool,
            order_id,
            None,
            ActivationCheck::closed().with_messages(vec![sms]),
        )
        .await
        .unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM number_messages WHERE order_id=$1")
                .bind(order_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        database.cleanup().await;
    }
}
