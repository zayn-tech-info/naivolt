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
    let expired = expires_at.is_some_and(|expiry| expiry <= Utc::now());

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
            let _ = state.numbers.cancel(&provider_id).await;
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
        Ok(ActivationState::Pending) if expired => {
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
    use crate::config::{Config, Environment};
    use crate::funding_provider::{AnyFundingProvider, StubFunding};
    use crate::google_keys::GoogleKeys;
    use crate::notify::{AnyNotifier, LogNotifier};
    use crate::number_provider::{AnyNumberProvider, ScriptedStubProvider};
    use crate::payout_provider;
    use crate::pricing::Rates;
    use crate::signer::{AnyAddressProvider, LocalSigner};
    use crate::state::AppState;
    use crate::test_database::IsolatedDatabase;
    use naivolt_auth::session::SessionKeys;
    use rust_decimal_macros::dec;
    use std::sync::Arc;

    fn test_config() -> Config {
        Config {
            environment: Environment::Development,
            bind_addr: "127.0.0.1:0".into(),
            database_url: String::new(),
            jwt_secret: "01234567890123456789012345678901".into(),
            termii_api_key: None,
            termii_sender_id: "Naivolt".into(),
            resend_api_key: None,
            operations_alert_email: None,
            email_from: "test@example.test".into(),
            signer_url: None,
            dev_mnemonic: None,
            auto_approve_kyc: false,
            dev_otp_code: None,
            paystack_secret_key: None,
            google_client_id: None,
            fivesim_api_key: None,
            fivesim_currency: Some("USD".into()),
            google_allowed_emails: Vec::new(),
            admin_token: None,
            web_app_url: "http://localhost".into(),
            numbers_margin: dec!(1.25),
            usd_ngn_mid: dec!(1600),
            spread_ngn_per_usd: dec!(20),
        }
    }

    fn test_state(pool: PgPool, numbers: AnyNumberProvider) -> AppState {
        let config = test_config();
        AppState {
            db: pool,
            keys: Arc::new(SessionKeys::from_secret(config.jwt_secret.as_bytes()).unwrap()),
            notifier: Arc::new(AnyNotifier::Log(LogNotifier)),
            addresses: Arc::new(AnyAddressProvider::Local(
                LocalSigner::from_mnemonic(
                    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
                )
                .unwrap(),
            )),
            rates: Rates::new(&config),
            payouts: Arc::new(payout_provider::AnyPayoutProvider::Stub(
                payout_provider::StubProvider,
            )),
            numbers: Arc::new(numbers),
            funding: Arc::new(AnyFundingProvider::Stub(StubFunding)),
            google_keys: Arc::new(GoogleKeys::new()),
            google_client_id: None,
            dev_otp_code: None,
            auto_approve_kyc: false,
            google_allowed_emails: Arc::new(Vec::new()),
            admin_token: None,
            operations_alert_email: None,
            web_app_url: "http://localhost".into(),
        }
    }

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

    async fn expired_awaiting_order(db: &PgPool, token: Uuid, suffix: &str) -> Uuid {
        use sqlx::Executor;
        let user_id: Uuid = sqlx::query_scalar("INSERT INTO users(email) VALUES($1) RETURNING id")
            .bind(format!("expiry-{suffix}@example.test"))
            .fetch_one(db)
            .await
            .unwrap();
        let user_account: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_accounts (kind, user_id, asset) VALUES ('user_ngn', $1, 'NGN') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(db)
        .await
        .unwrap();
        db.execute(
            "INSERT INTO ledger_accounts (kind, asset) VALUES ('number_payable_pending', 'NGN') ON CONFLICT DO NOTHING;
             INSERT INTO ledger_accounts (kind, asset) VALUES ('number_revenue', 'NGN') ON CONFLICT DO NOTHING",
        )
        .await
        .unwrap();
        let pending: Uuid = sqlx::query_scalar(
            "SELECT id FROM ledger_accounts WHERE kind = 'number_payable_pending' AND asset = 'NGN'",
        )
        .fetch_one(db)
        .await
        .unwrap();
        let reference = format!("NVNO-EXPIRY-{suffix}");
        let journal_id: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_journals(kind,reference,idempotency_key) VALUES('number_reserve',$1,$2) RETURNING id",
        )
        .bind(&reference)
        .bind(format!("expiry-reserve-{suffix}"))
        .fetch_one(db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
             VALUES ($1, $2, 'NGN', 500), ($1, $3, 'NGN', -500)",
        )
        .bind(journal_id)
        .bind(user_account)
        .bind(pending)
        .execute(db)
        .await
        .unwrap();
        sqlx::query_scalar(
            "INSERT INTO number_orders(
                user_id,product_id,country_id,price_ngn,status,reference,reserved_journal_id,
                idempotency_key,idempotency_payload_complete,reconciliation_payload_complete,
                provider_order_id,expires_at,reconcile_claim_token,reconcile_claimed_until
             )
             SELECT $1,p.id,c.id,500,'awaiting_code',$2,$3,$4,true,true,$5,now() - interval '1 minute',$6,now()+interval '60 seconds'
               FROM number_products p,number_countries c ORDER BY p.id,c.id LIMIT 1
             RETURNING id",
        )
        .bind(user_id)
        .bind(reference)
        .bind(journal_id)
        .bind(Uuid::new_v4())
        .bind(format!("provider-expiry-{suffix}"))
        .bind(token)
        .fetch_one(db)
        .await
        .unwrap()
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

    #[tokio::test]
    async fn expired_order_with_sms_settles_instead_of_refunding() {
        let database = IsolatedDatabase::new("reconcile_expiry_received_test").await;
        let token = Uuid::new_v4();
        let id = expired_awaiting_order(&database.pool, token, "RECV").await;
        let created_at: DateTime<Utc> =
            sqlx::query_scalar("SELECT created_at FROM number_orders WHERE id=$1")
                .bind(id)
                .fetch_one(&database.pool)
                .await
                .unwrap();
        let state = test_state(
            database.pool.clone(),
            AnyNumberProvider::ScriptedStub(ScriptedStubProvider::received()),
        );
        process(
            &state,
            (
                id,
                token,
                "awaiting_code".into(),
                Some("provider-expiry-RECV".into()),
                None,
                Some(Utc::now() - chrono::Duration::minutes(1)),
                created_at,
            ),
        )
        .await
        .unwrap();
        let row: (String, bool, bool) = sqlx::query_as(
            "SELECT status, settled_journal_id IS NOT NULL, refunded_journal_id IS NOT NULL
               FROM number_orders WHERE id=$1",
        )
        .bind(id)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(row, ("delivered".into(), true, false));
        database.cleanup().await;
    }

    #[tokio::test]
    async fn expired_pending_order_refunds() {
        let database = IsolatedDatabase::new("reconcile_expiry_pending_test").await;
        let token = Uuid::new_v4();
        let id = expired_awaiting_order(&database.pool, token, "PEND").await;
        let created_at: DateTime<Utc> =
            sqlx::query_scalar("SELECT created_at FROM number_orders WHERE id=$1")
                .bind(id)
                .fetch_one(&database.pool)
                .await
                .unwrap();
        let state = test_state(
            database.pool.clone(),
            AnyNumberProvider::ScriptedStub(ScriptedStubProvider::pending()),
        );
        process(
            &state,
            (
                id,
                token,
                "awaiting_code".into(),
                Some("provider-expiry-PEND".into()),
                None,
                Some(Utc::now() - chrono::Duration::minutes(1)),
                created_at,
            ),
        )
        .await
        .unwrap();
        let row: (String, bool, bool) = sqlx::query_as(
            "SELECT status, settled_journal_id IS NOT NULL, refunded_journal_id IS NOT NULL
               FROM number_orders WHERE id=$1",
        )
        .bind(id)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(row, ("expired".into(), false, true));
        database.cleanup().await;
    }

    #[tokio::test]
    async fn expired_order_retries_when_supplier_check_fails() {
        let database = IsolatedDatabase::new("reconcile_expiry_check_fail_test").await;
        let token = Uuid::new_v4();
        let id = expired_awaiting_order(&database.pool, token, "FAIL").await;
        let created_at: DateTime<Utc> =
            sqlx::query_scalar("SELECT created_at FROM number_orders WHERE id=$1")
                .bind(id)
                .fetch_one(&database.pool)
                .await
                .unwrap();
        let state = test_state(
            database.pool.clone(),
            AnyNumberProvider::ScriptedStub(ScriptedStubProvider::failing()),
        );
        process(
            &state,
            (
                id,
                token,
                "awaiting_code".into(),
                Some("provider-expiry-FAIL".into()),
                None,
                Some(Utc::now() - chrono::Duration::minutes(1)),
                created_at,
            ),
        )
        .await
        .unwrap();
        let row: (String, bool, Option<String>) = sqlx::query_as(
            "SELECT status, refunded_journal_id IS NOT NULL, reconcile_last_error_category
               FROM number_orders WHERE id=$1",
        )
        .bind(id)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(
            row,
            (
                "awaiting_code".into(),
                false,
                Some("provider_unavailable".into())
            )
        );
        database.cleanup().await;
    }
}
