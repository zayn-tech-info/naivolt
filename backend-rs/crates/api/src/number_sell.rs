//! Who we currently sell numbers from.
//!
//! List, buy, and catalogue sync read this. Open orders ignore it.
//! Seed is 5SIM on and everything else off, so an unfunded wallet or a stale
//! key cannot reach the shop even if that key is still in the environment.
//!
//! One row per supplier (`number_sell_providers`, migration 0024) rather than
//! a column per supplier: adding the next one is an INSERT, not a migration
//! against a widening table.

use crate::error::ApiResult;
use sqlx::PgPool;
use std::collections::BTreeMap;

pub const AUDIT_TARGET: uuid::Uuid = uuid::Uuid::from_u128(1);

/// Every supplier the buy path knows how to reach.
pub const KNOWN_PROVIDERS: &[&str] = &[
    "fivesim",
    "smspool",
    "smsactivate",
    "daisysms",
    "smshub",
    "tigersms",
];

#[derive(Clone, Debug, Default)]
pub struct SellSettings {
    enabled: BTreeMap<String, bool>,
}

impl SellSettings {
    pub fn from_pairs(pairs: impl IntoIterator<Item = (String, bool)>) -> Self {
        Self {
            enabled: pairs.into_iter().collect(),
        }
    }

    pub fn is_enabled(&self, provider: &str) -> bool {
        self.enabled.get(provider).copied().unwrap_or(false)
    }

    pub fn fivesim_enabled(&self) -> bool {
        self.is_enabled("fivesim")
    }

    pub fn smspool_enabled(&self) -> bool {
        self.is_enabled("smspool")
    }

    /// Every supplier row, for the admin view.
    pub fn all(&self) -> &BTreeMap<String, bool> {
        &self.enabled
    }

    /// At least one live supplier must stay on, or the shop sells nothing.
    pub fn any_enabled(&self) -> bool {
        self.enabled.values().any(|on| *on)
    }

    /// The providers the buy path may draw from, best-ranked first elsewhere.
    /// `include_stub` only ever true when funding is not live.
    pub fn source_providers(&self, include_stub: bool) -> Vec<&'static str> {
        let mut out: Vec<&'static str> = KNOWN_PROVIDERS
            .iter()
            .filter(|name| self.is_enabled(name))
            .copied()
            .collect();
        if include_stub {
            out.push("stub");
        }
        out
    }

    pub fn allows_live_fivesim_catalog(&self, live_primary: bool) -> bool {
        !live_primary || self.fivesim_enabled()
    }
}

fn seed() -> SellSettings {
    SellSettings::from_pairs(
        KNOWN_PROVIDERS
            .iter()
            .map(|name| ((*name).to_string(), *name == "fivesim")),
    )
}

async fn fetch_rows(db: &PgPool) -> ApiResult<Vec<(String, bool)>> {
    Ok(
        sqlx::query_as("SELECT provider, enabled FROM number_sell_providers ORDER BY provider")
            .fetch_all(db)
            .await?,
    )
}

/// Seed is 5SIM on, everything else off. All-off is illegal (PUT refuses it).
/// Recreate that seed if the table is empty or every flag is false, so
/// operators always start from a valid state.
pub async fn load(db: &PgPool) -> ApiResult<SellSettings> {
    let rows = fetch_rows(db).await?;
    if !rows.is_empty() {
        let settings = SellSettings::from_pairs(rows);
        if settings.any_enabled() {
            return Ok(settings);
        }
    }
    for provider in KNOWN_PROVIDERS {
        sqlx::query(
            "INSERT INTO number_sell_providers (provider, enabled)
             VALUES ($1, $2)
             ON CONFLICT (provider) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()",
        )
        .bind(provider)
        .bind(*provider == "fivesim")
        .execute(db)
        .await?;
    }
    Ok(seed())
}

/// Write the operator's choice. Refuses to turn everything off.
pub async fn store(db: &PgPool, wanted: &SellSettings) -> ApiResult<()> {
    for (provider, enabled) in wanted.all() {
        sqlx::query(
            "INSERT INTO number_sell_providers (provider, enabled)
             VALUES ($1, $2)
             ON CONFLICT (provider) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()",
        )
        .bind(provider)
        .bind(enabled)
        .execute(db)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_database::IsolatedDatabase;

    #[test]
    fn stub_joins_enabled_live_suppliers() {
        let sell = SellSettings::from_pairs([
            ("fivesim".to_string(), true),
            ("smspool".to_string(), false),
        ]);
        assert_eq!(sell.source_providers(true), vec!["fivesim", "stub"]);
        assert_eq!(sell.source_providers(false), vec!["fivesim"]);
        assert!(sell.allows_live_fivesim_catalog(false));
        assert!(sell.allows_live_fivesim_catalog(true));
        let off = SellSettings::from_pairs([
            ("fivesim".to_string(), false),
            ("smspool".to_string(), true),
        ]);
        assert!(!off.allows_live_fivesim_catalog(true));
        assert!(off.allows_live_fivesim_catalog(false));
    }

    #[test]
    fn a_new_supplier_is_listed_only_once_enabled() {
        let mut sell = SellSettings::from_pairs([("fivesim".to_string(), true)]);
        assert_eq!(sell.source_providers(false), vec!["fivesim"]);
        sell = SellSettings::from_pairs([
            ("fivesim".to_string(), true),
            ("daisysms".to_string(), true),
        ]);
        // Order follows KNOWN_PROVIDERS, not the alphabet.
        assert_eq!(sell.source_providers(false), vec!["fivesim", "daisysms"]);
    }

    #[test]
    fn an_unknown_supplier_never_becomes_a_source() {
        let sell = SellSettings::from_pairs([("someone-elses-api".to_string(), true)]);
        assert!(sell.source_providers(false).is_empty());
    }

    #[tokio::test]
    async fn load_recreates_seed_when_rows_are_missing() {
        let database = IsolatedDatabase::new("sell_missing_row").await;
        sqlx::query("DELETE FROM number_sell_providers")
            .execute(&database.pool)
            .await
            .unwrap();
        let sell = load(&database.pool).await.unwrap();
        assert!(sell.fivesim_enabled());
        assert!(!sell.smspool_enabled());
        let again = load(&database.pool).await.unwrap();
        assert!(again.fivesim_enabled());
        assert!(!again.smspool_enabled());
        database.cleanup().await;
    }

    #[tokio::test]
    async fn an_all_off_table_falls_back_to_the_seed() {
        let database = IsolatedDatabase::new("sell_all_off").await;
        sqlx::query("UPDATE number_sell_providers SET enabled = false")
            .execute(&database.pool)
            .await
            .unwrap();
        let sell = load(&database.pool).await.unwrap();
        assert!(sell.fivesim_enabled(), "the shop must not go dark");
        database.cleanup().await;
    }

    #[tokio::test]
    async fn stored_flags_survive_a_reload() {
        let database = IsolatedDatabase::new("sell_store").await;
        store(
            &database.pool,
            &SellSettings::from_pairs([
                ("fivesim".to_string(), false),
                ("daisysms".to_string(), true),
            ]),
        )
        .await
        .unwrap();
        let sell = load(&database.pool).await.unwrap();
        assert!(!sell.fivesim_enabled());
        assert!(sell.is_enabled("daisysms"));
        database.cleanup().await;
    }
}
