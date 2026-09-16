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
    use crate::test_database::IsolatedDatabase;
    use axum::body::to_bytes;
    use axum::response::IntoResponse;
    use naivolt_auth::session::SessionKeys;
    use rust_decimal_macros::dec;
    use sqlx::Executor;
    use std::sync::Arc;

    const ADMIN: &str = "test-admin-token-please-rotate-24";
    const TOTP_KEY: &[u8] = b"01234567890123456789012345678901";

    fn test_config() -> Config {
        Config {
            environment: Environment::Development,
            bind_addr: "127.0.0.1:0".into(),
            database_url: String::new(),
            jwt_secret: "01234567890123456789012345678901".into(),
            termii_api_key: None,
            termii_sender_id: "Naivolt".into(),
            resend_api_key: None,
            operations_alert_email: Some("ops@example.test".into()),
            email_from: "test@example.test".into(),
            signer_url: None,
            dev_mnemonic: None,
            auto_approve_kyc: false,
            dev_otp_code: None,
            paystack_secret_key: None,
            google_client_id: None,
            fivesim_api_key: None,
            fivesim_currency: Some("USD".into()),
            smspool_api_key: None,
            smspool_currency: Some("USD".into()),
            smspool_base_url: "https://api.smspool.net".into(),
            activate_keys: Vec::new(),
            google_allowed_emails: Vec::new(),
            admin_token: Some(ADMIN.into()),
            web_app_url: "http://localhost".into(),
            numbers_margin: dec!(1.25),
            usd_ngn_mid: dec!(1600),
            spread_ngn_per_usd: dec!(20),
            cors_allowed_origins: vec!["http://localhost:5173".into()],
            trusted_proxy_loopback: false,
            rate_limits: crate::config::RateLimitQuotas::defaults(),
            operator_totp_key: Some(TOTP_KEY.to_vec()),
            admin_refund_cap_ngn: Decimal::from(100_000),
            numbers_min_price_fraction: Decimal::new(6, 1),
        }
    }

    fn test_state(pool: sqlx::PgPool, numbers: AnyNumberProvider) -> AppState {
        let config = test_config();
        AppState {
            db: pool,
            keys: Arc::new(SessionKeys::from_secret(config.jwt_secret.as_bytes()).unwrap()),
            notifier: Arc::new(AnyNotifier::Log(LogNotifier)),
            addresses: Arc::new(AnyAddressProvider::Local(
                LocalSigner::from_mnemonic(crate::signer::tests::TEST_MNEMONIC).unwrap(),
            )),
            rates: Rates::new(&config),
            payouts: Arc::new(payout_provider::AnyPayoutProvider::Stub(
                payout_provider::StubProvider,
            )),
            numbers: Arc::new(numbers.into()),
            funding: Arc::new(AnyFundingProvider::Stub(StubFunding)),
            google_keys: Arc::new(GoogleKeys::new()),
            google_client_id: None,
            dev_otp_code: None,
            auto_approve_kyc: false,
            google_allowed_emails: Arc::new(Vec::new()),
            admin_token: Some(ADMIN.into()),
            operations_alert_email: Some("ops@example.test".into()),
            operator_totp_key: Some(TOTP_KEY.to_vec()),
            admin_refund_cap_ngn: Decimal::from(100_000),
            numbers_min_price_fraction: Decimal::new(6, 1),
            totp_lockouts: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            web_app_url: "http://localhost".into(),
        }
    }

    fn admin_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-admin-token", ADMIN.parse().unwrap());
        headers
    }

    fn operator_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-operator-session", token.parse().unwrap());
        headers
    }

    async fn err_code(err: ApiError) -> String {
        let response = err.into_response();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        body["code"].as_str().unwrap().to_string()
    }

    async fn held_order(
        db: &sqlx::PgPool,
        suffix: &str,
        status: &str,
        provider_order_id: Option<&str>,
        phone: Option<&str>,
        sms_code: Option<&str>,
    ) -> Uuid {
        let user_id: Uuid = sqlx::query_scalar("INSERT INTO users (email) VALUES ($1) RETURNING id")
            .bind(format!("ops-{suffix}@example.test"))
            .fetch_one(db)
            .await
            .unwrap();
        let user_account: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_accounts (kind, user_id, asset)
             VALUES ('user_ngn', $1, 'NGN') RETURNING id",
        )
        .bind(user_id)
        .fetch_one(db)
        .await
        .unwrap();
        db.execute(
            "INSERT INTO ledger_accounts (kind, asset) VALUES ('number_payable_pending', 'NGN')
             ON CONFLICT DO NOTHING;
             INSERT INTO ledger_accounts (kind, asset) VALUES ('number_revenue', 'NGN')
             ON CONFLICT DO NOTHING",
        )
        .await
        .unwrap();
        let pending: Uuid = sqlx::query_scalar(
            "SELECT id FROM ledger_accounts WHERE kind = 'number_payable_pending' AND asset = 'NGN'",
        )
        .fetch_one(db)
        .await
        .unwrap();
        let reference = format!("NVNO-OPS-{suffix}");
        let reserve_id: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_journals (kind, reference, idempotency_key)
             VALUES ('number_reserve', $1, $2) RETURNING id",
        )
        .bind(&reference)
        .bind(format!("reserve-ops-{suffix}"))
        .fetch_one(db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
             VALUES ($1, $2, 'NGN', 500), ($1, $3, 'NGN', -500)",
        )
        .bind(reserve_id)
        .bind(user_account)
        .bind(pending)
        .execute(db)
        .await
        .unwrap();
        sqlx::query_scalar(
            "INSERT INTO number_orders (
                user_id, product_id, country_id, price_ngn, status, reference, reserved_journal_id,
                idempotency_key, idempotency_payload_complete, reconciliation_payload_complete,
                provider, provider_order_id, phone_number, sms_code, provider_purchase_started_at,
                expires_at, reconcile_last_error_category, review_required_at, review_reason
             )
             SELECT $1, p.id, c.id, 500, $2, $3, $4, $5, true, true, 'stub', $6, $7, $8, now(),
                    now() + interval '20 minutes', 'provider_unavailable',
                    CASE WHEN $2 = 'review_required' THEN now() ELSE NULL END,
                    CASE WHEN $2 = 'review_required' THEN 'purchase_outcome_unknown' ELSE NULL END
               FROM number_products p, number_countries c
              ORDER BY p.id, c.id LIMIT 1
             RETURNING id",
        )
        .bind(user_id)
        .bind(status)
        .bind(reference)
        .bind(reserve_id)
        .bind(Uuid::new_v4())
        .bind(provider_order_id)
        .bind(phone)
        .bind(sms_code)
        .fetch_one(db)
        .await
        .unwrap()
    }

    async fn enroll_and_login(state: &AppState, email: &str) -> String {
        let _ = enroll_operator(
            State(state.clone()),
            admin_headers(),
            Json(EnrollBody {
                email: email.into(),
            }),
        )
        .await
        .unwrap();
        let packed: Vec<u8> =
            sqlx::query_scalar("SELECT totp_secret FROM operators WHERE email = $1")
                .bind(email)
                .fetch_one(&state.db)
                .await
                .unwrap();
        let secret = operator::decrypt_totp_secret(TOTP_KEY, &packed).unwrap();
        let totp = operator::totp_code(&secret, email).unwrap();
        create_session(
            State(state.clone()),
            Json(SessionBody {
                email: email.into(),
                totp,
            }),
        )
        .await
        .unwrap()
        .0
        .token
    }

    #[tokio::test]
    async fn wrong_admin_token_is_not_found_on_search() {
        let database = IsolatedDatabase::new("ops_token_404").await;
        let state = test_state(
            database.pool.clone(),
            AnyNumberProvider::Stub(crate::number_provider::StubProvider),
        );
        let mut headers = HeaderMap::new();
        headers.insert("x-admin-token", "nope".parse().unwrap());
        let err = list_orders(
            State(state),
            headers,
            Query(OrderSearch {
                reference: Some(Uuid::new_v4().to_string()),
                email: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err_code(err).await, "NOT_FOUND");
        database.cleanup().await;
    }

    #[tokio::test]
    async fn overview_extras_come_from_open_orders_and_prices() {
        let database = IsolatedDatabase::new("ops_overview").await;
        let pool = database.pool.clone();
        sqlx::query("UPDATE number_prices SET synced_at = now() WHERE synced_at IS NULL")
            .execute(&pool)
            .await
            .unwrap();
        let _id = held_order(&pool, "ov", "awaiting_code", Some("stub-ov"), None, None).await;
        let state = test_state(
            pool,
            AnyNumberProvider::Stub(crate::number_provider::StubProvider),
        );
        let overview = overview(State(state), admin_headers()).await.unwrap().0;
        assert!(overview.oldest_open_age_seconds.is_some());
        assert!(overview.catalogue_synced_at.is_some());
        assert_eq!(overview.operator_refunds_last24h, 0);
        assert_eq!(
            overview.last_provider_error_category.as_deref(),
            Some("provider_unavailable")
        );
        assert!(overview.fivesim_enabled);
        assert!(!overview.smspool_enabled);
        database.cleanup().await;
    }

    #[tokio::test]
    async fn detail_masks_phone_and_hides_sms() {
        let database = IsolatedDatabase::new("ops_mask").await;
        let pool = database.pool.clone();
        let id = held_order(
            &pool,
            "mask",
            "awaiting_code",
            Some("stub-mask"),
            Some("+000123456789"),
            Some("654321"),
        )
        .await;
        let state = test_state(
            pool,
            AnyNumberProvider::Stub(crate::number_provider::StubProvider),
        );
        let detail = order_detail(State(state), admin_headers(), Path(id))
            .await
            .unwrap()
            .0;
        assert_eq!(detail.phone_number.as_deref(), Some("********6789"));
        let encoded = serde_json::to_string(&detail).unwrap();
        assert!(!encoded.contains("654321"));
        assert!(!encoded.contains("sms"));
        assert_eq!(detail.provider.as_str(), "stub");
        assert_eq!(detail.provider_order_id.as_deref(), Some("stub-mask"));
        database.cleanup().await;
    }

    #[tokio::test]
    async fn enroll_session_recheck_refund_and_replay() {
        let database = IsolatedDatabase::new("ops_happy").await;
        let pool = database.pool.clone();
        let stub = ScriptedStubProvider::pending();
        let id = held_order(
            &pool,
            "happy",
            "awaiting_code",
            Some("stub-happy"),
            Some("+00099998888"),
            Some("111111"),
        )
        .await;
        let state = test_state(pool.clone(), AnyNumberProvider::ScriptedStub(stub.clone()));
        let token = enroll_and_login(&state, "operator@example.test").await;

        let unknown = list_orders(
            State(state.clone()),
            admin_headers(),
            Query(OrderSearch {
                reference: Some(Uuid::new_v4().to_string()),
                email: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(unknown.is_empty());

        let found = list_orders(
            State(state.clone()),
            admin_headers(),
            Query(OrderSearch {
                reference: Some(id.to_string()),
                email: Some("ops-happy@example.test".into()),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(found.len(), 1);

        let dup = enroll_operator(
            State(state.clone()),
            admin_headers(),
            Json(EnrollBody {
                email: "operator@example.test".into(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err_code(dup).await, "CONFLICT");

        let mut only_session = HeaderMap::new();
        only_session.insert("x-operator-session", token.parse().unwrap());
        let enroll_with_session_only = enroll_operator(
            State(state.clone()),
            only_session,
            Json(EnrollBody {
                email: "other@example.test".into(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err_code(enroll_with_session_only).await, "NOT_FOUND");

        let rechecked = recheck_order(State(state.clone()), operator_headers(&token), Path(id))
            .await
            .unwrap()
            .0;
        assert_eq!(rechecked.status, "awaiting_code");
        assert_eq!(stub.buy_calls(), 0);

        let mut refund_headers = operator_headers(&token);
        let key = Uuid::new_v4().to_string();
        refund_headers.insert("Idempotency-Key", key.parse().unwrap());
        let first = refund_order(
            State(state.clone()),
            refund_headers.clone(),
            Path(id),
            Json(RefundBody {
                reason: Some("customer asked".into()),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(first.status, "cancelled");
        let replay = refund_order(
            State(state.clone()),
            refund_headers,
            Path(id),
            Json(RefundBody { reason: None }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(replay.refunded_journal_id, first.refunded_journal_id);

        let audits: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_log WHERE action = 'number_refund' AND target = $1",
        )
        .bind(id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audits, 1);
        let alerts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM operator_alerts WHERE number_order_id = $1 AND dedupe_key LIKE 'number-refund:%'",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(alerts, 1);

        delete_session(State(state.clone()), operator_headers(&token))
            .await
            .unwrap();
        database.cleanup().await;
    }

    #[tokio::test]
    async fn review_without_provider_id_does_not_buy() {
        let database = IsolatedDatabase::new("ops_recheck_block").await;
        let pool = database.pool.clone();
        let stub = ScriptedStubProvider::pending();
        let id = held_order(&pool, "rev", "review_required", None, None, None).await;
        let state = test_state(pool, AnyNumberProvider::ScriptedStub(stub.clone()));
        let token = enroll_and_login(&state, "recheck@example.test").await;
        let err = recheck_order(State(state), operator_headers(&token), Path(id))
            .await
            .unwrap_err();
        assert_eq!(err_code(err).await, "RECHECK_UNAVAILABLE");
        assert_eq!(stub.buy_calls(), 0);
        database.cleanup().await;
    }

    #[tokio::test]
    async fn exhausted_recheck_inserts_one_alert_without_buying() {
        // covers: AC-10 exhausted recheck alert, AC-12 scripted stub
        let database = IsolatedDatabase::new("ops_exhausted").await;
        let pool = database.pool.clone();
        let stub = ScriptedStubProvider::failing();
        let id = held_order(
            &pool,
            "exh",
            "awaiting_code",
            Some("stub-exh"),
            None,
            None,
        )
        .await;
        sqlx::query("UPDATE number_orders SET reconcile_attempt_count = 4 WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        let state = test_state(pool.clone(), AnyNumberProvider::ScriptedStub(stub.clone()));
        let token = enroll_and_login(&state, "exhausted@example.test").await;
        let first = recheck_order(State(state.clone()), operator_headers(&token), Path(id))
            .await
            .unwrap()
            .0;
        assert_eq!(first.status, "awaiting_code");
        assert_eq!(stub.buy_calls(), 0);
        let key = format!("number-recheck-exhausted:{id}");
        let alerts: Vec<(String, String)> = sqlx::query_as(
            "SELECT dedupe_key, state FROM operator_alerts WHERE number_order_id = $1 AND dedupe_key = $2",
        )
        .bind(id)
        .bind(&key)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].0, key);
        assert_eq!(alerts[0].1, "pending");

        let _again = recheck_order(State(state), operator_headers(&token), Path(id))
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM operator_alerts WHERE dedupe_key = $1",
        )
        .bind(&key)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1);
        database.cleanup().await;
    }

    #[tokio::test]
    async fn worker_claim_blocks_operator_refund() {
        let database = IsolatedDatabase::new("ops_claim").await;
        let pool = database.pool.clone();
        let id = held_order(
            &pool,
            "claim",
            "awaiting_code",
            Some("stub-claim"),
            None,
            None,
        )
        .await;
        sqlx::query(
            "UPDATE number_orders
                SET reconcile_claim_token = gen_random_uuid(),
                    reconcile_claimed_until = now() + interval '60 seconds'
              WHERE id = $1",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
        let state = test_state(
            pool.clone(),
            AnyNumberProvider::Stub(crate::number_provider::StubProvider),
        );
        let token = enroll_and_login(&state, "claim@example.test").await;
        let mut headers = operator_headers(&token);
        headers.insert(
            "Idempotency-Key",
            Uuid::new_v4().to_string().parse().unwrap(),
        );
        let err = refund_order(
            State(state),
            headers,
            Path(id),
            Json(RefundBody { reason: None }),
        )
        .await
        .unwrap_err();
        assert_eq!(err_code(err).await, "CLAIM_CONFLICT");
        let journals: Option<Uuid> =
            sqlx::query_scalar("SELECT refunded_journal_id FROM number_orders WHERE id = $1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(journals.is_none());
        database.cleanup().await;
    }

    #[tokio::test]
    async fn refund_over_cap_is_refused() {
        let database = IsolatedDatabase::new("ops_cap").await;
        let pool = database.pool.clone();
        let id = held_order(&pool, "cap", "awaiting_code", Some("stub-cap"), None, None).await;
        let mut state = test_state(
            pool,
            AnyNumberProvider::Stub(crate::number_provider::StubProvider),
        );
        state.admin_refund_cap_ngn = Decimal::from(1);
        let token = enroll_and_login(&state, "cap@example.test").await;
        let mut headers = operator_headers(&token);
        headers.insert(
            "Idempotency-Key",
            Uuid::new_v4().to_string().parse().unwrap(),
        );
        let err = refund_order(
            State(state),
            headers,
            Path(id),
            Json(RefundBody { reason: None }),
        )
        .await
        .unwrap_err();
        assert_eq!(err_code(err).await, "REFUND_CAP");
        database.cleanup().await;
    }

    #[tokio::test]
    async fn disabled_operator_cannot_refund() {
        let database = IsolatedDatabase::new("ops_disabled").await;
        let pool = database.pool.clone();
        let id = held_order(&pool, "dis", "awaiting_code", Some("stub-dis"), None, None).await;
        let state = test_state(
            pool.clone(),
            AnyNumberProvider::Stub(crate::number_provider::StubProvider),
        );
        let token = enroll_and_login(&state, "disabled@example.test").await;
        sqlx::query("UPDATE operators SET disabled_at = now() WHERE email = $1")
            .bind("disabled@example.test")
            .execute(&pool)
            .await
            .unwrap();
        let mut headers = operator_headers(&token);
        headers.insert(
            "Idempotency-Key",
            Uuid::new_v4().to_string().parse().unwrap(),
        );
        let err = refund_order(
            State(state),
            headers,
            Path(id),
            Json(RefundBody { reason: None }),
        )
        .await
        .unwrap_err();
        assert_eq!(err_code(err).await, "FORBIDDEN");
        database.cleanup().await;
    }

    #[tokio::test]
    async fn five_wrong_totp_codes_lock_the_email() {
        let database = IsolatedDatabase::new("ops_lock").await;
        let state = test_state(
            database.pool.clone(),
            AnyNumberProvider::Stub(crate::number_provider::StubProvider),
        );
        let _ = enroll_operator(
            State(state.clone()),
            admin_headers(),
            Json(EnrollBody {
                email: "lock@example.test".into(),
            }),
        )
        .await
        .unwrap();
        for _ in 0..5 {
            let err = create_session(
                State(state.clone()),
                Json(SessionBody {
                    email: "lock@example.test".into(),
                    totp: "000000".into(),
                }),
            )
            .await
            .unwrap_err();
            assert_eq!(err_code(err).await, "BAD_REQUEST");
        }
        let locked = create_session(
            State(state),
            Json(SessionBody {
                email: "lock@example.test".into(),
                totp: "000000".into(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err_code(locked).await, "TOTP_LOCKED");
        database.cleanup().await;
    }

    #[tokio::test]
    async fn sell_settings_need_operator_and_keep_one_on() {
        let database = IsolatedDatabase::new("ops_sell_settings").await;
        let state = test_state(
            database.pool.clone(),
            AnyNumberProvider::Stub(crate::number_provider::StubProvider),
        );
        let missing = put_sell_settings(
            State(state.clone()),
            HeaderMap::new(),
            Json(SellSettingsBody {
                fivesim_enabled: true,
                smspool_enabled: true,
                providers: Default::default(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err_code(missing).await, "NOT_FOUND");

        let token = enroll_and_login(&state, "sell@example.test").await;
        let both_off = put_sell_settings(
            State(state.clone()),
            operator_headers(&token),
            Json(SellSettingsBody {
                fivesim_enabled: false,
                smspool_enabled: false,
                providers: Default::default(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err_code(both_off).await, "LAST_PROVIDER");
        let still = crate::number_sell::load(&state.db).await.unwrap();
        assert!(still.fivesim_enabled());
        assert!(!still.smspool_enabled());

        let updated = put_sell_settings(
            State(state.clone()),
            operator_headers(&token),
            Json(SellSettingsBody {
                fivesim_enabled: true,
                smspool_enabled: true,
                providers: Default::default(),
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(updated.fivesim_enabled);
        assert!(updated.smspool_enabled);
        let audits: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_log WHERE action = 'sell_settings'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(audits, 1);
        database.cleanup().await;
    }
}
