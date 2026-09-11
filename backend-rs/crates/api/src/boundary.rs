//! Production HTTP boundary: CORS, client IP, rate limits, query cap, headers.

use crate::config::{RateLimitQuotas, PRODUCTION_WEB_ORIGIN};
use crate::error::ApiError;
use axum::extract::{ConnectInfo, Request};
use axum::http::header::{HeaderName, AUTHORIZATION};
use axum::http::{HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use governor::clock::{Clock, DefaultClock};
use governor::state::keyed::DefaultKeyedStateStore;
use governor::{Quota, RateLimiter};
use naivolt_auth::session::SessionKeys;
use std::net::{IpAddr, SocketAddr};
use std::num::NonZeroU32;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{AllowOrigin, CorsLayer};

type Keyed = RateLimiter<String, DefaultKeyedStateStore<String>, DefaultClock>;

const MAX_QUERY_BYTES: usize = 2048;
static MISSING_REAL_IP: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub struct BoundaryState {
    pub origins: Vec<String>,
    trusted_proxy_loopback: bool,
    keys: Arc<SessionKeys>,
    limiters: Limiters,
}

#[derive(Clone)]
struct Limiters {
    global_ip: Arc<Keyed>,
    auth_ip: Arc<Keyed>,
    public_read_ip: Arc<Keyed>,
    funding_ip: Arc<Keyed>,
    funding_user: Arc<Keyed>,
    purchase_ip: Arc<Keyed>,
    purchase_user: Arc<Keyed>,
    poll_ip: Arc<Keyed>,
    poll_user: Arc<Keyed>,
    cancel_ip: Arc<Keyed>,
    cancel_user: Arc<Keyed>,
}

impl Limiters {
    fn new(quotas: RateLimitQuotas) -> Self {
        Self {
            global_ip: keyed(quotas.global_ip),
            auth_ip: keyed(quotas.auth_ip),
            public_read_ip: keyed(quotas.public_read_ip),
            funding_ip: keyed(quotas.funding_ip),
            funding_user: keyed(quotas.funding_user),
            purchase_ip: keyed(quotas.purchase_ip),
            purchase_user: keyed(quotas.purchase_user),
            poll_ip: keyed(quotas.poll_ip),
            poll_user: keyed(quotas.poll_user),
            cancel_ip: keyed(quotas.cancel_ip),
            cancel_user: keyed(quotas.cancel_user),
        }
    }
}

fn keyed(per_minute: u32) -> Arc<Keyed> {
    let n = NonZeroU32::new(per_minute.max(1)).expect("quota");
    Arc::new(RateLimiter::keyed(Quota::per_minute(n)))
}

impl BoundaryState {
    pub fn new(
        origins: Vec<String>,
        trusted_proxy_loopback: bool,
        quotas: RateLimitQuotas,
        keys: Arc<SessionKeys>,
    ) -> Self {
        Self {
            origins,
            trusted_proxy_loopback,
            keys,
            limiters: Limiters::new(quotas),
        }
    }
}

pub fn cors_layer(origins: &[String]) -> CorsLayer {
    let values: Vec<HeaderValue> = origins
        .iter()
        .map(|origin| {
            HeaderValue::from_str(origin).unwrap_or_else(|_| {
                HeaderValue::from_static(PRODUCTION_WEB_ORIGIN)
            })
        })
        .collect();
    CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            HeaderName::from_static("authorization"),
            HeaderName::from_static("content-type"),
            HeaderName::from_static("idempotency-key"),
            HeaderName::from_static("x-admin-token"),
            HeaderName::from_static("x-operator-session"),
            HeaderName::from_static("cookie"),
        ])
        .allow_origin(AllowOrigin::list(values))
        .allow_credentials(true)
}

pub fn apply<S>(router: Router<S>, boundary: BoundaryState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let cors = cors_layer(&boundary.origins);
    router
        .layer(axum::middleware::from_fn_with_state(
            boundary,
            rate_limit,
        ))
        .layer(axum::middleware::from_fn(query_length))
        .layer(axum::middleware::from_fn(security_headers))
        .layer(cors)
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    response
}

async fn query_length(request: Request, next: Next) -> Response {
    if request
        .uri()
        .query()
        .is_some_and(|query| query.len() > MAX_QUERY_BYTES)
    {
        return ApiError::BadRequest("query string is too long".into()).into_response();
    }
    next.run(request).await
}

async fn rate_limit(state: axum::extract::State<BoundaryState>, request: Request, next: Next) -> Response {
    if request.method() == Method::OPTIONS || request.uri().path() == "/health" {
        return next.run(request).await;
    }

    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
        .unwrap_or_else(|| IpAddr::from([127, 0, 0, 1]));
    let ip = client_ip(&state, peer, request.headers());
    let user_id = peek_user_id(&state.keys, request.headers());

    if let Some(response) = enforce(&state, request.method(), request.uri().path(), ip, user_id) {
        return response;
    }
    next.run(request).await
}

fn client_ip(
    state: &BoundaryState,
    peer: IpAddr,
    headers: &axum::http::HeaderMap,
) -> IpAddr {
    if !state.trusted_proxy_loopback || !peer.is_loopback() {
        return peer;
    }
    match headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| raw.trim().parse::<IpAddr>().ok())
    {
        Some(ip) => ip,
        None => {
            if !MISSING_REAL_IP.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    "X-Real-IP missing or unusable behind a loopback proxy; using the TCP peer"
                );
            }
            peer
        }
    }
}

fn peek_user_id(keys: &SessionKeys, headers: &axum::http::HeaderMap) -> Option<uuid::Uuid> {
    let header = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let token = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))?;
    keys.verify_access(token.trim()).ok().map(|claims| claims.sub)
}

fn enforce(
    state: &BoundaryState,
    method: &Method,
    path: &str,
    ip: IpAddr,
    user_id: Option<uuid::Uuid>,
) -> Option<Response> {
    let ip_key = ip.to_string();
    let (ip_limiter, user_limiter) = bucket(&state.limiters, method, path);
    if let Some(response) = check(ip_limiter, &ip_key) {
        return Some(response);
    }
    if let (Some(limiter), Some(user_id)) = (user_limiter, user_id) {
        if let Some(response) = check(limiter, &user_id.to_string()) {
            return Some(response);
        }
    }
    None
}

fn bucket<'a>(
    limiters: &'a Limiters,
    method: &Method,
    path: &str,
) -> (&'a Keyed, Option<&'a Keyed>) {
    if method == Method::POST && path.starts_with("/api/v1/auth/") {
        return (&limiters.auth_ip, None);
    }
    if method == Method::GET
        && (path == "/api/v1/numbers/catalog"
            || path == "/api/v1/numbers/offers"
            || path == "/api/v1/numbers/products"
            || path.starts_with("/api/v1/numbers/products/")
            || path == "/api/v1/rates")
    {
        return (&limiters.public_read_ip, None);
    }
    if method == Method::POST && path == "/api/v1/funding/intents" {
        return (&limiters.funding_ip, Some(&limiters.funding_user));
    }
    if method == Method::POST && path == "/api/v1/numbers/orders" {
        return (&limiters.purchase_ip, Some(&limiters.purchase_user));
    }
    if method == Method::GET
        && (path == "/api/v1/numbers/orders" || is_order_detail(path))
    {
        return (&limiters.poll_ip, Some(&limiters.poll_user));
    }
    if method == Method::POST && path.starts_with("/api/v1/numbers/orders/") && path.ends_with("/cancel")
    {
        return (&limiters.cancel_ip, Some(&limiters.cancel_user));
    }
    (&limiters.global_ip, None)
}

fn is_order_detail(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/v1/numbers/orders/") else {
        return false;
    };
    !rest.is_empty() && !rest.contains('/')
}

fn check(limiter: &Keyed, key: &str) -> Option<Response> {
    match limiter.check_key(&key.to_owned()) {
        Ok(()) => None,
        Err(not_until) => {
            let clock = DefaultClock::default();
            let wait = not_until.wait_time_from(clock.now());
            Some(
                ApiError::RateLimited {
                    retry_after: retry_seconds(wait),
                }
                .into_response(),
            )
        }
    }
}

fn retry_seconds(wait: Duration) -> i64 {
    let extra = u64::from(wait.subsec_nanos() > 0);
    (wait.as_secs() + extra).max(1) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use axum::routing::{get, post};
    use chrono::Utc;
    use std::sync::OnceLock;
    use tower::ServiceExt;
    use uuid::Uuid;

    fn keys() -> Arc<SessionKeys> {
        static KEYS: OnceLock<Arc<SessionKeys>> = OnceLock::new();
        KEYS.get_or_init(|| Arc::new(SessionKeys::from_secret(&[7u8; 48]).expect("secret")))
            .clone()
    }

    fn app(origins: Vec<String>, quotas: RateLimitQuotas, trusted: bool) -> axum::Router {
        let boundary = BoundaryState::new(origins, trusted, quotas, keys());
        apply(
            Router::new()
                .route("/health", get(|| async { "ok" }))
                .route("/api/v1/numbers/offers", get(|| async { "offers" }))
                .route(
                    "/api/v1/numbers/orders/:id",
                    get(|| async { "order" }),
                )
                .route("/api/v1/auth/google", post(|| async { "auth" }))
                .route(
                    "/api/v1/admin/sell-settings",
                    axum::routing::put(|| async { "sell" }),
                ),
            boundary,
        )
    }

    fn with_peer(mut request: Request<Body>, ip: [u8; 4]) -> Request<Body> {
        request.extensions_mut().insert(ConnectInfo(SocketAddr::from((ip, 9))));
        request
    }

    async fn send(app: axum::Router, request: Request<Body>) -> axum::http::Response<Body> {
        app.oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn production_origin_is_allowed_on_preflight_and_get() {
        let origin = PRODUCTION_WEB_ORIGIN;
        let app = app(vec![origin.to_owned()], RateLimitQuotas::defaults(), false);
        let preflight = with_peer(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/v1/numbers/offers")
                .header("origin", origin)
                .header("access-control-request-method", "GET")
                .header(
                    "access-control-request-headers",
                    "authorization,content-type,idempotency-key,x-admin-token",
                )
                .body(Body::empty())
                .unwrap(),
            [127, 0, 0, 1],
        );
        let response = send(app.clone(), preflight).await;
        assert_eq!(
            response.headers().get("access-control-allow-origin").unwrap(),
            origin
        );
        let allow = response
            .headers()
            .get("access-control-allow-headers")
            .unwrap()
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        for header in [
            "authorization",
            "content-type",
            "idempotency-key",
            "x-admin-token",
            "x-operator-session",
            "cookie",
        ] {
            assert!(allow.contains(header), "{allow}");
        }
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-credentials")
                .unwrap(),
            "true"
        );

        let put_preflight = with_peer(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/v1/admin/sell-settings")
                .header("origin", origin)
                .header("access-control-request-method", "PUT")
                .header(
                    "access-control-request-headers",
                    "content-type,x-operator-session",
                )
                .body(Body::empty())
                .unwrap(),
            [127, 0, 0, 1],
        );
        let put_response = send(app.clone(), put_preflight).await;
        assert_eq!(put_response.status(), axum::http::StatusCode::OK);
        let allow_methods = put_response
            .headers()
            .get("access-control-allow-methods")
            .unwrap()
            .to_str()
            .unwrap()
            .to_ascii_uppercase();
        assert!(
            allow_methods.split(',').any(|m| m.trim() == "PUT"),
            "{allow_methods}"
        );
        assert_eq!(
            put_response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            origin
        );

        let get = with_peer(
            Request::builder()
                .uri("/api/v1/numbers/offers")
                .header("origin", origin)
                .body(Body::empty())
                .unwrap(),
            [127, 0, 0, 1],
        );
        let response = send(app, get).await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers().get("access-control-allow-origin").unwrap(),
            origin
        );
        assert_eq!(
            response.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        assert_eq!(response.headers().get("x-frame-options").unwrap(), "DENY");
    }

    #[tokio::test]
    async fn development_localhost_origins_are_allowed() {
        let app = app(
            vec![
                "http://localhost:5173".into(),
                "http://127.0.0.1:5173".into(),
            ],
            RateLimitQuotas::defaults(),
            false,
        );
        for origin in ["http://localhost:5173", "http://127.0.0.1:5173"] {
            let response = send(
                app.clone(),
                with_peer(
                    Request::builder()
                        .uri("/health")
                        .header("origin", origin)
                        .body(Body::empty())
                        .unwrap(),
                    [127, 0, 0, 1],
                ),
            )
            .await;
            assert_eq!(
                response.headers().get("access-control-allow-origin").unwrap(),
                origin
            );
        }
    }

    #[tokio::test]
    async fn foreign_and_vercel_origins_are_rejected() {
        let app = app(
            vec![PRODUCTION_WEB_ORIGIN.to_owned()],
            RateLimitQuotas::defaults(),
            false,
        );
        for origin in [
            "https://evil.example",
            "https://naivolt-website-murex.vercel.app",
        ] {
            let response = send(
                app.clone(),
                with_peer(
                    Request::builder()
                        .uri("/health")
                        .header("origin", origin)
                        .body(Body::empty())
                        .unwrap(),
                    [127, 0, 0, 1],
                ),
            )
            .await;
            assert!(
                response.headers().get("access-control-allow-origin").is_none(),
                "{origin}"
            );
        }
    }

    #[tokio::test]
    async fn missing_origin_still_reaches_health() {
        let app = app(
            vec![PRODUCTION_WEB_ORIGIN.to_owned()],
            RateLimitQuotas::defaults(),
            false,
        );
        let response = send(
            app,
            with_peer(
                Request::builder().uri("/health").body(Body::empty()).unwrap(),
                [127, 0, 0, 1],
            ),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[..], b"ok");
    }

    #[tokio::test]
    async fn a_tight_bucket_returns_rate_limited() {
        let mut quotas = RateLimitQuotas::defaults();
        quotas.public_read_ip = 2;
        let app = app(
            vec![PRODUCTION_WEB_ORIGIN.to_owned()],
            quotas,
            false,
        );
        let hit = || {
            with_peer(
                Request::builder()
                    .uri("/api/v1/numbers/offers")
                    .body(Body::empty())
                    .unwrap(),
                [203, 0, 113, 9],
            )
        };
        assert_eq!(send(app.clone(), hit()).await.status(), axum::http::StatusCode::OK);
        assert_eq!(send(app.clone(), hit()).await.status(), axum::http::StatusCode::OK);
        let limited = send(app, hit()).await;
        assert_eq!(limited.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
        assert!(limited.headers().get("retry-after").is_some());
        let bytes = to_bytes(limited.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "RATE_LIMITED");
        assert!(body["meta"]["retryAfter"].as_i64().unwrap() >= 1);
    }

    #[tokio::test]
    async fn poll_quota_allows_thirty_gets_for_one_user() {
        let app = app(
            vec![PRODUCTION_WEB_ORIGIN.to_owned()],
            RateLimitQuotas::defaults(),
            false,
        );
        let token = keys()
            .issue_access(Uuid::from_u128(1), Uuid::from_u128(2), 0, Utc::now())
            .expect("token");
        let order = Uuid::from_u128(9);
        for i in 0..30 {
            let response = send(
                app.clone(),
                with_peer(
                    Request::builder()
                        .uri(format!("/api/v1/numbers/orders/{order}"))
                        .header("authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                    [198, 51, 100, 1],
                ),
            )
            .await;
            assert_eq!(response.status(), axum::http::StatusCode::OK, "call {i}");
        }
        let limited = send(
            app,
            with_peer(
                Request::builder()
                    .uri(format!("/api/v1/numbers/orders/{order}"))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
                [198, 51, 100, 1],
            ),
        )
        .await;
        assert_eq!(limited.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn a_query_over_2048_bytes_is_rejected() {
        let app = app(
            vec![PRODUCTION_WEB_ORIGIN.to_owned()],
            RateLimitQuotas::defaults(),
            false,
        );
        let query = "x".repeat(2049);
        let response = send(
            app,
            with_peer(
                Request::builder()
                    .uri(format!("/health?{query}"))
                    .body(Body::empty())
                    .unwrap(),
                [127, 0, 0, 1],
            ),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn loopback_proxy_uses_x_real_ip() {
        let mut quotas = RateLimitQuotas::defaults();
        quotas.auth_ip = 1;
        let app = app(
            vec![PRODUCTION_WEB_ORIGIN.to_owned()],
            quotas,
            true,
        );
        let first = with_peer(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/google")
                .header("x-real-ip", "203.0.113.10")
                .body(Body::empty())
                .unwrap(),
            [127, 0, 0, 1],
        );
        assert_eq!(send(app.clone(), first).await.status(), axum::http::StatusCode::OK);
        let second_same = with_peer(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/google")
                .header("x-real-ip", "203.0.113.10")
                .body(Body::empty())
                .unwrap(),
            [127, 0, 0, 1],
        );
        assert_eq!(
            send(app.clone(), second_same).await.status(),
            axum::http::StatusCode::TOO_MANY_REQUESTS
        );
        let other = with_peer(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/google")
                .header("x-real-ip", "203.0.113.11")
                .body(Body::empty())
                .unwrap(),
            [127, 0, 0, 1],
        );
        assert_eq!(send(app, other).await.status(), axum::http::StatusCode::OK);
    }
}
