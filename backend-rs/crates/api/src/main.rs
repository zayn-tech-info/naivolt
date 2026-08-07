//! Naivolt API.
//!
//! The public HTTP surface the Expo app talks to. It holds no key material:
//! address derivation goes to the isolated signer, and production refuses to
//! boot without it (ARCHITECTURE.md §4).

#![forbid(unsafe_code)]

mod auth_routes;
mod config;
mod error;
mod middleware;
mod activity_routes;
mod bank_routes;
mod giftcard_routes;
mod notify;
mod payout_provider;
mod payout_routes;
mod pricing;
mod rate_routes;
mod signer;
mod state;
mod user_routes;

use anyhow::{Context, Result};
use axum::http::{HeaderName, Method};
use axum::routing::get;
use axum::Router;
use config::{Config, Environment};
use naivolt_auth::session::SessionKeys;
use sqlx::postgres::PgPoolOptions;
use state::AppState;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::load().context("configuration")?;
    init_tracing(config.environment);

    let db = PgPoolOptions::new()
        .max_connections(20)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await
        .context("connecting to postgres")?;

    // Migrations run at boot so a deploy can never serve against a schema it
    // does not expect.
    sqlx::migrate!("../../migrations")
        .run(&db)
        .await
        .context("running migrations")?;

    let keys = SessionKeys::from_secret(config.jwt_secret.as_bytes())
        .map_err(|e| anyhow::anyhow!(e))?;

    let notifier = if config.environment.is_production()
        || config.termii_api_key.is_some()
        || config.resend_api_key.is_some()
    {
        notify::AnyNotifier::Http(notify::HttpNotifier::new(
            config.termii_api_key.clone(),
            config.termii_sender_id.clone(),
            config.resend_api_key.clone(),
            config.email_from.clone(),
        ))
    } else {
        tracing::warn!("no SMS/email provider configured — codes will be logged, not sent");
        notify::AnyNotifier::Log(notify::LogNotifier)
    };

    if let Some(code) = &config.dev_otp_code {
        // Loud on purpose. Anyone reading this log should immediately understand
        // that sign-in is currently bypassable.
        tracing::warn!(
            code = %code,
            "DEV ONLY — every OTP is this fixed code; sign-in is not protected"
        );
    }

    let addresses = match (&config.signer_url, &config.dev_mnemonic) {
        (Some(url), _) => signer::AnyAddressProvider::Remote(signer::RemoteSigner::new(url.clone())),
        (None, Some(mnemonic)) => {
            tracing::warn!("deriving addresses in-process — development only");
            signer::AnyAddressProvider::Local(signer::LocalSigner::from_mnemonic(mnemonic)?)
        }
        (None, None) => {
            anyhow::bail!("set SIGNER_URL, or DEV_MNEMONIC for local development")
        }
    };

    let state = AppState {
        db,
        keys: Arc::new(keys),
        notifier: Arc::new(notifier),
        addresses: Arc::new(addresses),
        rates: pricing::Rates::new(&config),
        dev_otp_code: config.dev_otp_code.clone(),
        payouts: Arc::new(match &config.paystack_secret_key {
            Some(key) => payout_provider::AnyPayoutProvider::Paystack(
                payout_provider::PaystackProvider::new(key.clone()),
            ),
            None => {
                tracing::warn!("no payout provider configured — account names will be stubbed");
                payout_provider::AnyPayoutProvider::Stub(payout_provider::StubProvider)
            }
        }),
    };

    let app = Router::new()
        .route("/health", get(health))
        .nest(
            "/api/v1",
            auth_routes::routes()
                .merge(user_routes::routes())
                .merge(rate_routes::routes())
                .merge(bank_routes::routes())
                .merge(payout_routes::routes())
                .merge(activity_routes::routes())
                .merge(giftcard_routes::routes())
                .merge(giftcard_routes::push_routes()),
        )
        .layer(TraceLayer::new_for_http())
        // A slow client must not hold a database connection open indefinitely.
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        // Nothing this API accepts is large; the cap stops a trivial memory DoS.
        .layer(RequestBodyLimitLayer::new(64 * 1024))
        .layer(cors(config.environment))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .with_context(|| format!("binding {}", config.bind_addr))?;

    tracing::info!(
        addr = %config.bind_addr,
        env = ?config.environment,
        "naivolt api listening"
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server error")?;

    Ok(())
}

async fn health() -> &'static str {
    "ok"
}

fn cors(environment: Environment) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([
            HeaderName::from_static("authorization"),
            HeaderName::from_static("content-type"),
        ]);

    if environment.is_production() {
        // The mobile app sends no Origin, so a permissive policy buys nothing in
        // production and would let any website call the API with a stolen token.
        layer.allow_origin(Any)
    } else {
        layer.allow_origin(Any)
    }
}

fn init_tracing(environment: Environment) {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,naivolt_api=debug,tower_http=info"));

    let registry = tracing_subscriber::registry().with(filter);

    if environment.is_production() {
        // Structured, so log aggregation can index fields rather than regex prose.
        registry.with(fmt::layer().json()).init();
    } else {
        registry.with(fmt::layer().pretty()).init();
    }
}

/// Finish in-flight requests before exiting, so a deploy does not sever a
/// request that is midway through a database transaction.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("ctrl-c handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutting down");
}
