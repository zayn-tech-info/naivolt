//! Naivolt API.
//!
//! The public HTTP surface the Expo app talks to. It holds no key material:
//! address derivation goes to the isolated signer, and production refuses to
//! boot without it (ARCHITECTURE.md §4).

#![forbid(unsafe_code)]

mod activity_routes;
mod admin_routes;
mod auth_routes;
mod bank_routes;
mod boundary;
mod config;
mod error;
mod funding_provider;
mod funding_reconciler;
mod funding_routes;
mod giftcard_routes;
mod google_keys;
mod kyc_routes;
mod middleware;
mod notify;
mod operator;
mod number_activate;
mod number_aggregator;
mod number_catalog;
mod number_offers;
mod number_order_transitions;
mod number_provider;
mod number_reconciler;
mod number_routes;
mod number_sell;
mod number_smspool;
mod payout_provider;
mod payout_routes;
mod pricing;
mod rate_routes;
mod session_cookie;
mod signer;
mod state;
#[cfg(test)]
mod test_database;
mod user_routes;

use anyhow::{Context, Result};
use axum::routing::get;
use axum::Router;
use config::{Config, Environment};
use naivolt_auth::session::SessionKeys;
use sqlx::postgres::PgPoolOptions;
use state::AppState;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
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

    let keys =
        SessionKeys::from_secret(config.jwt_secret.as_bytes()).map_err(|e| anyhow::anyhow!(e))?;

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
        (Some(url), _) => {
            signer::AnyAddressProvider::Remote(signer::RemoteSigner::new(url.clone()))
        }
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
        auto_approve_kyc: config.auto_approve_kyc,
        web_app_url: config.web_app_url.clone(),
        admin_token: config.admin_token.clone(),
        operations_alert_email: config.operations_alert_email.clone(),
        operator_totp_key: config.operator_totp_key.clone(),
        admin_refund_cap_ngn: config.admin_refund_cap_ngn,
        numbers_min_price_fraction: config.numbers_min_price_fraction,
        totp_lockouts: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        google_allowed_emails: Arc::new(config.google_allowed_emails.clone()),
        funding: Arc::new(match &config.paystack_secret_key {
            Some(key) => funding_provider::AnyFundingProvider::Paystack(
                funding_provider::PaystackFunding::new(key.clone()),
            ),
            None => {
                tracing::warn!("no funding provider configured — top-ups will be stubbed");
                funding_provider::AnyFundingProvider::Stub(funding_provider::StubFunding)
            }
        }),
        google_keys: Arc::new(google_keys::GoogleKeys::new()),
        google_client_id: config.google_client_id.clone(),
        numbers: Arc::new({
            let primary = match &config.fivesim_api_key {
                Some(key) => number_provider::AnyNumberProvider::FiveSim(
                    number_provider::FiveSimProvider::new(
                        key.clone(),
                        config.fivesim_currency.clone(),
                    ),
                ),
                None => {
                    tracing::warn!("no number provider configured — numbers will be stubbed");
                    number_provider::AnyNumberProvider::Stub(number_provider::StubProvider)
                }
            };
            number_provider::NumberProviders {
                primary,
                smspool: config.smspool_api_key.as_ref().map(|key| {
                    number_smspool::SmsPoolProvider::new(
                        key.clone(),
                        config.smspool_currency.clone(),
                        Some(config.smspool_base_url.clone()),
                    )
                }),
                activate: build_activate_providers(&config.activate_keys),
            }
        }),
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

    // A charge nobody came back for is still a charge (funding_reconciler.rs),
    // and a catalogue nobody synced shows every number as out of stock
    // (number_catalog.rs). Both run for the life of the process.
    funding_reconciler::spawn(state.clone());
    number_catalog::spawn(
        state.clone(),
        number_catalog::Pricing {
            usd_ngn: config.usd_ngn_mid,
            margin: config.numbers_margin,
            supplier_currency: config.fivesim_currency.clone(),
        },
        number_catalog::OfferSync {
            write_stub: config.fivesim_api_key.is_none(),
            fivesim_api_key: config.fivesim_api_key.clone(),
            smspool: config.smspool_api_key.as_ref().map(|key| {
                number_smspool::SmsPoolProvider::new(
                    key.clone(),
                    config.smspool_currency.clone(),
                    Some(config.smspool_base_url.clone()),
                )
            }),
            smspool_pricing: number_catalog::Pricing {
                usd_ngn: config.usd_ngn_mid,
                margin: config.numbers_margin,
                supplier_currency: config
                    .smspool_currency
                    .clone()
                    .or_else(|| Some("USD".into())),
            },
            activate: build_activate_providers(&config.activate_keys),
            activate_pricing: config
                .activate_keys
                .iter()
                .map(|creds| {
                    (
                        creds.provider.clone(),
                        number_catalog::Pricing {
                            usd_ngn: config.usd_ngn_mid,
                            margin: config.numbers_margin,
                            supplier_currency: creds.currency.clone(),
                        },
                    )
                })
                .collect(),
        },
    );
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let number_workers = number_reconciler::spawn(state.clone(), shutdown_rx);

    let boundary = boundary::BoundaryState::new(
        config.cors_allowed_origins.clone(),
        config.trusted_proxy_loopback,
        config.rate_limits,
        state.keys.clone(),
    );

    let app = boundary::apply(
        Router::new()
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
                    .merge(giftcard_routes::push_routes())
                    .merge(number_routes::routes())
                    .merge(funding_routes::routes())
                    .merge(kyc_routes::routes())
                    .merge(admin_routes::routes()),
            )
            .layer(TraceLayer::new_for_http())
            .layer(TimeoutLayer::with_status_code(
                axum::http::StatusCode::REQUEST_TIMEOUT,
                Duration::from_secs(30),
            ))
            .layer(RequestBodyLimitLayer::new(64 * 1024)),
        boundary,
    )
    .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.bind_addr)
        .await
        .with_context(|| format!("binding {}", config.bind_addr))?;

    tracing::info!(
        addr = %config.bind_addr,
        env = ?config.environment,
        "naivolt api listening"
    );

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            let _ = shutdown_tx.send(true);
        })
        .await
        .context("server error")?;

    number_workers.finish().await;

    Ok(())
}

/// Build one adapter per configured `handler_api.php` supplier.
///
/// An unrecognised provider name is dropped with a warning rather than failing
/// the boot: a typo in one supplier's env var should not take the API down when
/// the others are healthy.
fn build_activate_providers(
    credentials: &[config::ActivateCredentials],
) -> Vec<number_activate::ActivateProvider> {
    credentials
        .iter()
        .filter_map(|creds| {
            let Some(flavor) = number_activate::ActivateFlavor::parse(&creds.provider) else {
                tracing::warn!(provider = %creds.provider, "unknown number supplier, ignoring");
                return None;
            };
            tracing::info!(provider = %creds.provider, "number supplier configured");
            Some(number_activate::ActivateProvider::new(
                flavor,
                creds.api_key.clone(),
                creds.currency.clone(),
                creds.base_url.clone(),
            ))
        })
        .collect()
}

async fn health() -> &'static str {
    "ok"
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
