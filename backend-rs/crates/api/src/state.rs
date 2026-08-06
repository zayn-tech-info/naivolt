//! Shared application state.

use crate::notify::AnyNotifier;
use crate::pricing::Rates;
use crate::signer::AnyAddressProvider;
use naivolt_auth::session::SessionKeys;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub keys: Arc<SessionKeys>,
    pub notifier: Arc<AnyNotifier>,
    pub addresses: Arc<AnyAddressProvider>,
    pub rates: Rates,
}
