use crate::error::{ApiError, ApiResult};
use crate::payout_routes::{lock_user_ngn_account, platform_account};
use naivolt_core::Asset;
use naivolt_ledger::journal::JournalBuilder;
use naivolt_ledger::{AccountKind, JournalKind};
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub(crate) enum OrderTransition {
    Deliver { code: String, text: String },
    Refund { status: RefundStatus, reason: String },
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

pub(crate) async fn apply(
    db: &PgPool,
    order_id: Uuid,
    transition: OrderTransition,
) -> ApiResult<TransitionOutcome> {
    let requested = match &transition {
        OrderTransition::Deliver { .. } => "deliver",
        OrderTransition::Refund { status, .. } => status.as_str(),
    };
    let mut tx = db.begin().await.map_err(anyhow::Error::from)?;
    let row: Option<(Uuid, Decimal, String, String)> = sqlx::query_as(
        "SELECT user_id, price_ngn, reference, status
           FROM number_orders
          WHERE id = $1
          FOR UPDATE",
    )
    .bind(order_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;

    let (user_id, price_ngn, reference, current_status) = row.ok_or(ApiError::NotFound)?;
    if !matches!(current_status.as_str(), "reserved" | "awaiting_code") {
        tx.commit().await.map_err(anyhow::Error::from)?;
        tracing::info!(order = %reference, transition = requested, status = %current_status, outcome = "replayed", "number order transition completed");
        return Ok(TransitionOutcome::AlreadyTerminal(current_status));
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
            .entry(pending, AccountKind::NumberPayablePending, Asset::Ngn, price_ngn)
            .entry(revenue, AccountKind::NumberRevenue, Asset::Ngn, -price_ngn)
            .build()
            .map_err(|error| ApiError::Internal(anyhow::anyhow!(error)))?;
            (journal, "delivered", None, Some(code), Some(text))
        }
        OrderTransition::Refund { status, reason } => {
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
            .entry(pending, AccountKind::NumberPayablePending, Asset::Ngn, price_ngn)
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
                updated_at = now()
          WHERE id = $1 AND status IN ('reserved', 'awaiting_code')",
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
        let user_id: Uuid = sqlx::query_scalar(
            "INSERT INTO users (email) VALUES ($1) RETURNING id",
        )
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
        assert_eq!(outcomes.iter().filter(|o| **o == TransitionOutcome::Applied).count(), 1);

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
        assert_eq!(outcomes.iter().filter(|o| **o == TransitionOutcome::Applied).count(), 1);
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
        assert_eq!(outcomes.iter().filter(|o| **o == TransitionOutcome::Applied).count(), 1);
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
        assert_eq!(outcomes.iter().filter(|o| **o == TransitionOutcome::Applied).count(), 1);

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
}
