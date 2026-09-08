#[derive(Deserialize)]
pub struct OrderSearch {
    pub reference: Option<String>,
    pub email: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrderSummary {
    pub id: String,
    pub email: String,
    pub status: String,
    pub price_ngn: String,
    pub created_at: String,
    pub provider: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrderDetail {
    pub id: String,
    pub email: String,
    pub status: String,
    pub price_ngn: String,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: Option<String>,
    pub provider: String,
    pub provider_order_id: Option<String>,
    pub reconcile_last_error_category: Option<String>,
    pub phone_number: Option<String>,
    pub review_reason: Option<String>,
    pub reserved_journal_id: Option<String>,
    pub refunded_journal_id: Option<String>,
    pub settled_journal_id: Option<String>,
}

#[derive(Deserialize)]
pub struct EnrollBody {
    pub email: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub id: String,
    pub email: String,
    pub otpauth_uri: String,
}

#[derive(Deserialize)]
pub struct SessionBody {
    pub email: String,
    pub totp: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub token: String,
    pub expires_at: String,
}

#[derive(Default, Deserialize)]
pub struct RefundBody {
    pub reason: Option<String>,
}

fn totp_key(state: &AppState) -> ApiResult<&[u8]> {
    state
        .operator_totp_key
        .as_deref()
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("OPERATOR_TOTP_KEY is not set")))
}

fn lockout_window() -> Duration {
    Duration::from_secs(15 * 60)
}

fn totp_is_locked(state: &AppState, email: &str) -> bool {
    let Ok(mut map) = state.totp_lockouts.lock() else {
        return true;
    };
    let now = Instant::now();
    let window = lockout_window();
    let stamps = map.entry(email.to_lowercase()).or_default();
    stamps.retain(|at| now.duration_since(*at) < window);
    stamps.len() >= 5
}

fn record_totp_failure(state: &AppState, email: &str) {
    if let Ok(mut map) = state.totp_lockouts.lock() {
        map.entry(email.to_lowercase())
            .or_default()
            .push(Instant::now());
    }
}

fn clear_totp_failures(state: &AppState, email: &str) {
    if let Ok(mut map) = state.totp_lockouts.lock() {
        map.remove(&email.to_lowercase());
    }
}

fn bad_totp() -> ApiError {
    ApiError::BadRequest("that code isn't right".into())
}

async fn require_operator(state: &AppState, headers: &HeaderMap) -> ApiResult<Uuid> {
    let presented = headers
        .get("x-operator-session")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if presented.is_empty() {
        return Err(ApiError::NotFound);
    }
    let hash = operator::hash_session_token(presented.as_bytes());
    let row: Option<(Uuid, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT o.id, o.disabled_at
           FROM operator_sessions s
           JOIN operators o ON o.id = s.operator_id
          WHERE s.token_hash = $1 AND s.expires_at > now()",
    )
    .bind(hash)
    .fetch_optional(&state.db)
    .await?;
    let Some((id, disabled_at)) = row else {
        return Err(ApiError::NotFound);
    };
    if disabled_at.is_some() {
        return Err(ApiError::OperatorDisabled);
    }
    Ok(id)
}

fn journal_snapshot(
    status: &str,
    reserved: Option<Uuid>,
    refunded: Option<Uuid>,
    settled: Option<Uuid>,
) -> Value {
    json!({
        "status": status,
        "reservedJournalId": reserved.map(|id| id.to_string()),
        "refundedJournalId": refunded.map(|id| id.to_string()),
        "settledJournalId": settled.map(|id| id.to_string()),
    })
}

async fn insert_audit(
    db: &sqlx::PgPool,
    operator_id: Uuid,
    action: &str,
    target: Uuid,
    before: Value,
    after: Value,
) -> ApiResult<i64> {
    let before_s = before.to_string();
    let after_s = after.to_string();
    let prev: Option<String> =
        sqlx::query_scalar("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_optional(db)
            .await?;
    let hash = operator::audit_hash(
        prev.as_deref(),
        "admin",
        &operator_id.to_string(),
        action,
        &target.to_string(),
        &before_s,
        &after_s,
    );
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO audit_log (actor_type, actor_id, action, target, before, after, prev_hash, hash)
         VALUES ('admin', $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
         RETURNING id",
    )
    .bind(operator_id)
    .bind(action)
    .bind(target.to_string())
    .bind(&before_s)
    .bind(&after_s)
    .bind(prev)
    .bind(hash)
    .fetch_one(db)
    .await?;
    Ok(id)
}

async fn load_detail(db: &sqlx::PgPool, id: Uuid) -> ApiResult<OrderDetail> {
    let row: Option<(
        Uuid,
        String,
        String,
        Decimal,
        DateTime<Utc>,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Uuid>,
        Option<Uuid>,
        Option<Uuid>,
    )> = sqlx::query_as(
        "SELECT o.id, u.email, o.status, o.price_ngn, o.created_at, o.updated_at, o.expires_at,
                o.provider, o.provider_order_id, o.reconcile_last_error_category, o.phone_number,
                o.review_reason, o.reserved_journal_id, o.refunded_journal_id, o.settled_journal_id
           FROM number_orders o
           JOIN users u ON u.id = o.user_id
          WHERE o.id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let row = row.ok_or(ApiError::NotFound)?;
    Ok(OrderDetail {
        id: row.0.to_string(),
        email: row.1,
        status: row.2,
        price_ngn: row.3.normalize().to_string(),
        created_at: row.4.to_rfc3339(),
        updated_at: row.5.to_rfc3339(),
        expires_at: row.6.map(|at| at.to_rfc3339()),
        provider: row.7,
        provider_order_id: row.8,
        reconcile_last_error_category: row.9,
        phone_number: operator::mask_phone(row.10.as_deref()),
        review_reason: row.11,
        reserved_journal_id: row.12.map(|id| id.to_string()),
        refunded_journal_id: row.13.map(|id| id.to_string()),
        settled_journal_id: row.14.map(|id| id.to_string()),
    })
}

async fn order_journals(
    db: &sqlx::PgPool,
    id: Uuid,
) -> ApiResult<(String, Option<Uuid>, Option<Uuid>, Option<Uuid>)> {
    sqlx::query_as(
        "SELECT status, reserved_journal_id, refunded_journal_id, settled_journal_id
           FROM number_orders WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or(ApiError::NotFound)
}

async fn reject_if_claimed(db: &sqlx::PgPool, id: Uuid) -> ApiResult<()> {
    let row: Option<(String, Option<DateTime<Utc>>, Option<Uuid>)> = sqlx::query_as(
        "SELECT status, reconcile_claimed_until, refunded_journal_id FROM number_orders WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((_status, claimed_until, _refunded)) = row else {
        return Err(ApiError::NotFound);
    };
    if claimed_until.is_some_and(|until| until > Utc::now()) {
        return Err(ApiError::ClaimConflict);
    }
    Err(ApiError::Conflict(
        "This order is not holding a reservation that can be updated.".into(),
    ))
}

pub(crate) async fn list_orders(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<OrderSearch>,
) -> ApiResult<Json<Vec<OrderSummary>>> {
    authorise(&state, &headers)?;
    let email = query
        .email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase());
    let reference = query
        .reference
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Uuid::parse_str(value).ok());
    if email.is_none() && reference.is_none() {
        return Ok(Json(Vec::new()));
    }
    let rows: Vec<(Uuid, String, String, Decimal, DateTime<Utc>, String)> = sqlx::query_as(
        "SELECT o.id, u.email, o.status, o.price_ngn, o.created_at, o.provider
           FROM number_orders o
           JOIN users u ON u.id = o.user_id
          WHERE ($1::uuid IS NULL OR o.id = $1)
            AND ($2::text IS NULL OR lower(u.email) = $2)
          ORDER BY o.created_at DESC
          LIMIT 50",
    )
    .bind(reference)
    .bind(email)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, email, status, price, created_at, provider)| OrderSummary {
                id: id.to_string(),
                email,
                status,
                price_ngn: price.normalize().to_string(),
                created_at: created_at.to_rfc3339(),
                provider,
            })
            .collect(),
    ))
}

pub(crate) async fn order_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<OrderDetail>> {
    authorise(&state, &headers)?;
    Ok(Json(load_detail(&state.db, id).await?))
}

pub(crate) async fn enroll_operator(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EnrollBody>,
) -> ApiResult<Json<EnrollResponse>> {
    authorise(&state, &headers)?;
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') {
        return Err(ApiError::BadRequest("that email isn't valid".into()));
    }
    let key = totp_key(&state)?;
    let (secret, uri) = operator::new_totp(&email)?;
    let packed = operator::encrypt_totp_secret(key, &secret)?;
    let inserted: Result<Uuid, sqlx::Error> = sqlx::query_scalar(
        "INSERT INTO operators (email, totp_secret) VALUES ($1, $2) RETURNING id",
    )
    .bind(&email)
    .bind(packed)
    .fetch_one(&state.db)
    .await;
    let id = match inserted {
        Ok(id) => id,
        Err(sqlx::Error::Database(err)) if err.code().as_deref() == Some("23505") => {
            return Err(ApiError::Conflict("that operator is already enrolled".into()));
        }
        Err(err) => return Err(err.into()),
    };
    Ok(Json(EnrollResponse {
        id: id.to_string(),
        email,
        otpauth_uri: uri,
    }))
}

pub(crate) async fn create_session(
    State(state): State<AppState>,
    Json(body): Json<SessionBody>,
) -> ApiResult<Json<SessionResponse>> {
    let email = body.email.trim().to_lowercase();
    if totp_is_locked(&state, &email) {
        return Err(ApiError::TotpLocked);
    }
    let row: Option<(Uuid, Vec<u8>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, totp_secret, disabled_at FROM operators WHERE email = $1",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await?;
    let Some((id, packed, disabled_at)) = row else {
        record_totp_failure(&state, &email);
        return Err(bad_totp());
    };
    if disabled_at.is_some() {
        return Err(ApiError::OperatorDisabled);
    }
    let key = totp_key(&state)?;
    let secret = operator::decrypt_totp_secret(key, &packed)?;
    if !operator::totp_ok(&secret, &email, body.totp.trim()) {
        record_totp_failure(&state, &email);
        return Err(bad_totp());
    }
    clear_totp_failures(&state, &email);
    let (token, hash) = operator::new_session_token();
    let expires_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO operator_sessions (operator_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 minutes')
         RETURNING expires_at",
    )
    .bind(id)
    .bind(hash)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(SessionResponse {
        token,
        expires_at: expires_at.to_rfc3339(),
    }))
}

pub(crate) async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let presented = headers
        .get("x-operator-session")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if presented.is_empty() {
        return Err(ApiError::NotFound);
    }
    let hash = operator::hash_session_token(presented.as_bytes());
    let deleted = sqlx::query("DELETE FROM operator_sessions WHERE token_hash = $1")
        .bind(hash)
        .execute(&state.db)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn recheck_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<OrderDetail>> {
    let operator_id = require_operator(&state, &headers).await?;
    let row: Option<(
        String,
        Option<String>,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
        String,
        i32,
    )> = sqlx::query_as(
        "SELECT status, provider_order_id, provider_purchase_started_at, expires_at, provider,
                reconcile_attempt_count
           FROM number_orders WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let Some((status, provider_id, started_at, expires_at, provider, attempt_count)) = row else {
        return Err(ApiError::NotFound);
    };
    if status == "review_required" && provider_id.is_none() {
        return Err(ApiError::RecheckUnavailable);
    }
    let before = {
        let (status, reserved, refunded, settled) = order_journals(&state.db, id).await?;
        journal_snapshot(&status, reserved, refunded, settled)
    };
    let Some(claim) = number_reconciler::try_claim_held_order(&state.db, id).await? else {
        reject_if_claimed(&state.db, id).await?;
        return Err(ApiError::ClaimConflict);
    };

    if status == "reserved" {
        if started_at.is_none() {
            number_order_transitions::apply_claimed(
                &state.db,
                id,
                claim,
                OrderTransition::Refund {
                    status: RefundStatus::Failed,
                    reason: "purchase_not_started".into(),
                },
            )
            .await?;
            let (status, reserved, refunded, settled) = order_journals(&state.db, id).await?;
            insert_audit(
                &state.db,
                operator_id,
                "number_recheck",
                id,
                before,
                journal_snapshot(&status, reserved, refunded, settled),
            )
            .await?;
            return Ok(Json(load_detail(&state.db, id).await?));
        }
        if provider_id.is_none() {
            number_reconciler::mark_review_required(&state.db, id, claim, "purchase_outcome_unknown")
                .await?;
            let (status, reserved, refunded, settled) = order_journals(&state.db, id).await?;
            insert_audit(
                &state.db,
                operator_id,
                "number_recheck",
                id,
                before,
                journal_snapshot(&status, reserved, refunded, settled),
            )
            .await?;
            return Ok(Json(load_detail(&state.db, id).await?));
        }
    }

    let Some(provider_id) = provider_id else {
        let _ = number_reconciler::release_order(&state.db, id, claim, 1, None).await;
        return Err(ApiError::RecheckUnavailable);
    };

    let Some(slot) = number_reconciler::claim_slot(&state.db, claim).await? else {
        number_reconciler::release_order(&state.db, id, claim, 1, None).await?;
        return Err(ApiError::ServiceUnavailable(
            "Supplier checks are busy. Try again shortly.".into(),
        ));
    };
    let checked = state.numbers.check_for(&provider, &provider_id).await;
    number_reconciler::release_slot(&state.db, slot, claim).await?;
    match checked {
        Ok(check) => {
            if check.messages.is_empty()
                && (check.lifecycle == crate::number_provider::ActivationLifecycle::Closed
                    || expires_at.is_some_and(|expiry| expiry <= Utc::now()))
            {
                let _ = state.numbers.cancel_for(&provider, &provider_id).await;
            }
            map_claim_err(
                number_order_transitions::apply_check(&state.db, id, Some(claim), check).await,
            )?;
        }
        Err(_) => {
            number_reconciler::release_order(
                &state.db,
                id,
                claim,
                15,
                Some("provider_unavailable"),
            )
            .await?;
            if attempt_count >= 4 {
                sqlx::query(
                    "INSERT INTO operator_alerts(number_order_id, dedupe_key)
                     VALUES ($1, $2)
                     ON CONFLICT (dedupe_key) DO NOTHING",
                )
                .bind(id)
                .bind(format!("number-recheck-exhausted:{id}"))
                .execute(&state.db)
                .await?;
            }
            return Ok(Json(load_detail(&state.db, id).await?));
        }
    }
    let (status, reserved, refunded, settled) = order_journals(&state.db, id).await?;
    insert_audit(
        &state.db,
        operator_id,
        "number_recheck",
        id,
        before,
        journal_snapshot(&status, reserved, refunded, settled),
    )
    .await?;
    Ok(Json(load_detail(&state.db, id).await?))
}

fn map_claim_err<T>(result: ApiResult<T>) -> ApiResult<T> {
    match result {
        Err(ApiError::Conflict(message))
            if message.to_ascii_lowercase().contains("claim") =>
        {
            Err(ApiError::ClaimConflict)
        }
        other => other,
    }
}

fn idempotency_key(headers: &HeaderMap) -> ApiResult<Uuid> {
    let raw = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::BadRequest("Idempotency-Key header is required".into()))?;
    Uuid::parse_str(raw).map_err(|_| ApiError::BadRequest("Idempotency-Key must be a UUID".into()))
}

pub(crate) async fn refund_order(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<RefundBody>,
) -> ApiResult<Json<OrderDetail>> {
    let operator_id = require_operator(&state, &headers).await?;
    let idempotency = idempotency_key(&headers)?;
    let replay: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM audit_log
          WHERE action = 'number_refund'
            AND target = $1
            AND after->>'idempotencyKey' = $2
          ORDER BY id ASC
          LIMIT 1",
    )
    .bind(id.to_string())
    .bind(idempotency.to_string())
    .fetch_optional(&state.db)
    .await?;
    if replay.is_some() {
        return Ok(Json(load_detail(&state.db, id).await?));
    }

    let row: Option<(Decimal, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT price_ngn, status, refunded_journal_id FROM number_orders WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let Some((price_ngn, status, refunded)) = row else {
        return Err(ApiError::NotFound);
    };
    if refunded.is_some()
        || !matches!(
            status.as_str(),
            "reserved" | "awaiting_code" | "review_required"
        )
    {
        return Err(ApiError::Conflict(
            "This order is not holding a reservation that can be refunded.".into(),
        ));
    }
    if price_ngn > state.admin_refund_cap_ngn {
        return Err(ApiError::RefundCap);
    }

    let before = {
        let (status, reserved, refunded, settled) = order_journals(&state.db, id).await?;
        journal_snapshot(&status, reserved, refunded, settled)
    };
    let Some(claim) = number_reconciler::try_claim_held_order(&state.db, id).await? else {
        reject_if_claimed(&state.db, id).await?;
        return Err(ApiError::ClaimConflict);
    };

    map_claim_err(
        number_order_transitions::apply_claimed(
            &state.db,
            id,
            claim,
            OrderTransition::Refund {
                status: RefundStatus::Cancelled,
                reason: "operator".into(),
            },
        )
        .await
        .map(|_| ()),
    )?;

    let (status, reserved, refunded, settled) = order_journals(&state.db, id).await?;
    let mut after = journal_snapshot(&status, reserved, refunded, settled);
    if let Some(obj) = after.as_object_mut() {
        obj.insert("idempotencyKey".into(), json!(idempotency.to_string()));
        let reason = body
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(200).collect::<String>());
        if let Some(reason) = reason {
            obj.insert("reason".into(), json!(reason));
        }
    }
    let audit_id = insert_audit(
        &state.db,
        operator_id,
        "number_refund",
        id,
        before,
        after,
    )
    .await?;
    sqlx::query(
        "INSERT INTO operator_alerts(number_order_id, dedupe_key)
         VALUES ($1, $2)
         ON CONFLICT (dedupe_key) DO NOTHING",
    )
    .bind(id)
    .bind(format!("number-refund:{id}:{audit_id}"))
    .execute(&state.db)
    .await?;
    Ok(Json(load_detail(&state.db, id).await?))
}
