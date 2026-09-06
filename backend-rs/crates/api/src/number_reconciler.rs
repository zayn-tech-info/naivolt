use crate::error::{ApiError, ApiResult};
use crate::number_order_transitions::{self, OrderTransition, RefundStatus};
use crate::number_provider::ActivationState;
use crate::state::AppState;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use tokio::sync::watch;
use uuid::Uuid;

type ClaimedOrder = (
    Uuid,
    Uuid,
    String,
    Option<String>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
);

pub(crate) struct Workers(Vec<tokio::task::JoinHandle<()>>);

impl Workers {
    pub(crate) async fn finish(self) {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(25), async {
            for handle in self.0 {
                let _ = handle.await;
            }
        })
        .await;
    }
}

pub(crate) fn spawn(state: AppState, shutdown: watch::Receiver<bool>) -> Workers {
    let reconcile = tokio::spawn(reconcile_loop(state.clone(), shutdown.clone()));
    let alerts = tokio::spawn(alert_loop(state, shutdown));
    Workers(vec![reconcile, alerts])
}

async fn reconcile_loop(state: AppState, mut shutdown: watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow() {
            break;
        }
        if let Err(error) = sweep(&state).await {
            tracing::error!(error_category = "reconcile_sweep", error = %error, "number reconciliation sweep failed");
        }
        tokio::select! {
            _ = shutdown.changed() => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
        }
    }
}

async fn sweep(state: &AppState) -> ApiResult<()> {
    let rows: Vec<ClaimedOrder> = sqlx::query_as(
        "WITH due AS (
             SELECT id FROM number_orders
              WHERE reconciliation_payload_complete
                AND status IN ('reserved','awaiting_code')
                AND reconcile_next_at <= now()
                AND (reconcile_claimed_until IS NULL OR reconcile_claimed_until < now())
              ORDER BY reconcile_next_at FOR UPDATE SKIP LOCKED LIMIT 50
         )
         UPDATE number_orders o SET reconcile_claim_token = gen_random_uuid(),
                reconcile_claimed_until = now() + interval '60 seconds', updated_at = now()
           FROM due WHERE o.id = due.id
         RETURNING o.id, o.reconcile_claim_token, o.status, o.provider_order_id,
                   o.provider_purchase_started_at, o.expires_at, o.created_at",
    )
    .fetch_all(&state.db)
    .await
    .map_err(anyhow::Error::from)?;

    let mut tasks = tokio::task::JoinSet::new();
    for row in rows {
        let state = state.clone();
        tasks.spawn(async move {
            if let Err(error) = process(&state, row).await {
                tracing::warn!(error_category = "order_reconcile", error = %error, "number order reconciliation failed");
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    Ok(())
}

async fn process(state: &AppState, row: ClaimedOrder) -> ApiResult<()> {
    let (id, token, status, provider_id, started_at, expires_at, created_at) = row;
    if status == "reserved" {
        if started_at.is_none() {
            number_order_transitions::apply_claimed(
                &state.db,
                id,
                token,
                OrderTransition::Refund {
                    status: RefundStatus::Failed,
                    reason: "purchase_not_started".into(),
                },
            )
            .await?;
        } else if provider_id.is_none() {
            mark_review_required(&state.db, id, token, "purchase_outcome_unknown").await?;
        }
        return Ok(());
    }
    let provider_id = provider_id
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("awaiting order has no provider id")))?;
    if expires_at.is_some_and(|expiry| expiry <= Utc::now()) {
        let _ = state.numbers.cancel(&provider_id).await;
        number_order_transitions::apply_claimed(
            &state.db,
            id,
            token,
            OrderTransition::Refund {
                status: RefundStatus::Expired,
                reason: "expired".into(),
            },
        )
        .await?;
        return Ok(());
    }

    let Some(slot) = claim_slot(&state.db, token).await? else {
        release_order(&state.db, id, token, 1, None).await?;
        return Ok(());
    };
    let checked = state.numbers.check(&provider_id).await;
    release_slot(&state.db, slot, token).await?;
    match checked {
        Ok(ActivationState::Received {
            code,
            text,
            messages,
        }) => {
            number_order_transitions::deliver_claimed(&state.db, id, token, code, text, &messages)
                .await?;
        }
        Ok(ActivationState::Finished) => {
            number_order_transitions::apply_claimed(
                &state.db,
                id,
                token,
                OrderTransition::Refund {
                    status: RefundStatus::Expired,
                    reason: "supplier_finished".into(),
                },
            )
            .await?;
        }
        Ok(ActivationState::Pending) => {
            let delay = if Utc::now() - created_at < chrono::Duration::minutes(5) {
                10
            } else {
                30
            };
            release_order(&state.db, id, token, delay, None).await?;
        }
        Err(_) => {
            let attempts: i32 =
                sqlx::query_scalar("SELECT reconcile_attempt_count FROM number_orders WHERE id=$1")
                    .bind(id)
                    .fetch_one(&state.db)
                    .await?;
            let delay = (15_i64 * 2_i64.pow(attempts.clamp(0, 3) as u32)).min(120);
            release_order(&state.db, id, token, delay, Some("provider_unavailable")).await?;
        }
    }
    Ok(())
}

async fn claim_slot(db: &PgPool, token: Uuid) -> ApiResult<Option<i16>> {
    sqlx::query_scalar(
        "WITH available AS (SELECT slot FROM number_provider_slots
          WHERE claimed_until IS NULL OR claimed_until < now() ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1)
         UPDATE number_provider_slots s SET claim_token=$1, claimed_until=now()+interval '60 seconds'
          FROM available WHERE s.slot=available.slot RETURNING s.slot")
        .bind(token).fetch_optional(db).await.map_err(anyhow::Error::from).map_err(ApiError::Internal)
}

async fn release_slot(db: &PgPool, slot: i16, token: Uuid) -> ApiResult<()> {
    sqlx::query("UPDATE number_provider_slots SET claim_token=NULL, claimed_until=NULL WHERE slot=$1 AND claim_token=$2")
        .bind(slot).bind(token).execute(db).await?;
    Ok(())
}

async fn release_order(
    db: &PgPool,
    id: Uuid,
    token: Uuid,
    delay_seconds: i64,
    error: Option<&str>,
) -> ApiResult<()> {
    sqlx::query("UPDATE number_orders SET reconcile_last_checked_at=now(),
        reconcile_attempt_count=CASE WHEN $4::text IS NULL THEN 0 ELSE reconcile_attempt_count+1 END,
        reconcile_last_error_category=$4, reconcile_next_at=LEAST(COALESCE(expires_at, now()+interval '15 minutes'), now()+($3*interval '1 second')),
        reconcile_claim_token=NULL, reconcile_claimed_until=NULL, updated_at=now()
        WHERE id=$1 AND reconcile_claim_token=$2")
        .bind(id).bind(token).bind(delay_seconds).bind(error).execute(db).await?;
    Ok(())
}

pub(crate) async fn mark_review_required(
    db: &PgPool,
    id: Uuid,
    token: Uuid,
    reason: &str,
) -> ApiResult<()> {
    let mut tx = db.begin().await?;
    let changed = sqlx::query("UPDATE number_orders SET status='review_required', review_required_at=now(), review_reason=$3,
        reconcile_next_at=NULL, reconcile_claim_token=NULL, reconcile_claimed_until=NULL, updated_at=now()
        WHERE id=$1 AND status IN ('reserved','awaiting_code') AND reconcile_claim_token=$2 AND reconcile_claimed_until>now()")
        .bind(id).bind(token).bind(reason).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::Conflict(
            "The reconciliation claim is no longer current.".into(),
        ));
    }
    sqlx::query("INSERT INTO operator_alerts(number_order_id,dedupe_key) VALUES($1,'number-review:'||$1::text) ON CONFLICT(dedupe_key) DO NOTHING")
        .bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    tracing::warn!(order_id=%id, error_category=reason, "number order requires operator review");
    Ok(())
}

async fn alert_loop(state: AppState, mut shutdown: watch::Receiver<bool>) {
    loop {
        if *shutdown.borrow() {
            break;
        }
        if let Err(error) = deliver_alert(&state).await {
            tracing::warn!(error_category="alert_delivery", error=%error, "operator alert attempt failed");
        }
        tokio::select! { _ = shutdown.changed() => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {} }
    }
}

async fn deliver_alert(state: &AppState) -> ApiResult<()> {
    let token = Uuid::new_v4();
    let row: Option<(Uuid, String, String, DateTime<Utc>)> = sqlx::query_as(
        "WITH due AS (SELECT a.id FROM operator_alerts a WHERE state='pending' AND next_attempt_at<=now()
           AND (claimed_until IS NULL OR claimed_until<now()) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)
         UPDATE operator_alerts a SET claim_token=$1, claimed_until=now()+interval '60 seconds', updated_at=now()
          FROM due, number_orders o WHERE a.id=due.id AND o.id=a.number_order_id
         RETURNING a.id,o.reference,o.review_reason,o.review_required_at")
        .bind(token).fetch_optional(&state.db).await?;
    let Some((id, reference, reason, at)) = row else {
        return Ok(());
    };
    let Some(destination) = state.operations_alert_email.as_deref() else {
        schedule_alert_retry(&state.db, id, token, "not_configured").await?;
        return Ok(());
    };
    use crate::notify::Notifier;
    match state
        .notifier
        .send_operator_alert(destination, &reference, &reason, at)
        .await
    {
        Ok(()) => {
            sqlx::query("UPDATE operator_alerts SET state='delivered',delivered_at=now(),claim_token=NULL,claimed_until=NULL,updated_at=now() WHERE id=$1 AND claim_token=$2").bind(id).bind(token).execute(&state.db).await?;
        }
        Err(_) => schedule_alert_retry(&state.db, id, token, "delivery_failed").await?,
    }
    Ok(())
}

async fn schedule_alert_retry(db: &PgPool, id: Uuid, token: Uuid, category: &str) -> ApiResult<()> {
    sqlx::query("UPDATE operator_alerts SET attempt_count=attempt_count+1,last_error_category=$3,
      next_attempt_at=now()+(LEAST(900,15*power(2,LEAST(attempt_count,6)))::text||' seconds')::interval,
      claim_token=NULL,claimed_until=NULL,updated_at=now() WHERE id=$1 AND claim_token=$2")
      .bind(id).bind(token).bind(category).execute(db).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_database::IsolatedDatabase;

    async fn reserved_order(db: &PgPool, token: Uuid) -> Uuid {
        let user_id: Uuid = sqlx::query_scalar("INSERT INTO users(email) VALUES('reconcile@example.test') RETURNING id")
            .fetch_one(db).await.unwrap();
        let journal_id: Uuid = sqlx::query_scalar("INSERT INTO ledger_journals(kind,reference,idempotency_key) VALUES('number_reserve','reconcile-reserve','reconcile-reserve') RETURNING id")
            .fetch_one(db).await.unwrap();
        sqlx::query_scalar("INSERT INTO number_orders(user_id,product_id,country_id,price_ngn,status,reference,reserved_journal_id,idempotency_key,idempotency_payload_complete,reconciliation_payload_complete,provider_purchase_started_at,reconcile_claim_token,reconcile_claimed_until)
            SELECT $1,p.id,c.id,500,'reserved','NVNO-RECONCILE',$2,$3,true,true,now(),$4,now()+interval '60 seconds'
            FROM number_products p,number_countries c ORDER BY p.id,c.id LIMIT 1 RETURNING id")
            .bind(user_id).bind(journal_id).bind(Uuid::new_v4()).bind(token).fetch_one(db).await.unwrap()
    }

    #[tokio::test]
    async fn ambiguous_purchase_is_fenced_and_alerted_once() {
        let database = IsolatedDatabase::new("reconcile_review_test").await;
        let token = Uuid::new_v4();
        let id = reserved_order(&database.pool, token).await;
        mark_review_required(&database.pool, id, token, "purchase_outcome_unknown").await.unwrap();
        let replay = mark_review_required(&database.pool, id, token, "purchase_outcome_unknown").await;
        assert!(matches!(replay, Err(ApiError::Conflict(_))));
        let row: (String, i64, bool) = sqlx::query_as("SELECT o.status,count(a.id),o.refunded_journal_id IS NULL FROM number_orders o LEFT JOIN operator_alerts a ON a.number_order_id=o.id WHERE o.id=$1 GROUP BY o.id")
            .bind(id).fetch_one(&database.pool).await.unwrap();
        assert_eq!(row, ("review_required".into(), 1, true));
        database.cleanup().await;
    }

    #[tokio::test]
    async fn provider_slots_enforce_the_fleet_limit() {
        let database = IsolatedDatabase::new("reconcile_slot_test").await;
        let mut claims = Vec::new();
        for _ in 0..11 {
            let token = Uuid::new_v4();
            claims.push((claim_slot(&database.pool, token).await.unwrap(), token));
        }
        assert_eq!(claims.iter().filter(|(slot, _)| slot.is_some()).count(), 10);
        assert!(claims.last().unwrap().0.is_none());
        database.cleanup().await;
    }
}
