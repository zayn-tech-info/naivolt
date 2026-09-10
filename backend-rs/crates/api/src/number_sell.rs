//! Who we currently sell numbers from.
//!
//! List and buy read this row. Catalogue sync does not. Open orders ignore it.

use crate::error::{ApiError, ApiResult};
use sqlx::PgPool;

pub const AUDIT_TARGET: uuid::Uuid = uuid::Uuid::from_u128(1);

#[derive(Clone, Copy, Debug)]
pub struct SellSettings {
    pub fivesim_enabled: bool,
    pub smspool_enabled: bool,
}

impl SellSettings {
    pub fn source_providers(self, include_stub: bool) -> Vec<&'static str> {
        let mut out = Vec::with_capacity(3);
        if self.fivesim_enabled {
            out.push("fivesim");
        }
        if self.smspool_enabled {
            out.push("smspool");
        }
        if include_stub {
            out.push("stub");
        }
        out
    }

    pub fn allows_live_fivesim_catalog(self, live_primary: bool) -> bool {
        !live_primary || self.fivesim_enabled
    }
}

const SEED: SellSettings = SellSettings {
    fivesim_enabled: true,
    smspool_enabled: false,
};

async fn fetch_row(db: &PgPool) -> ApiResult<Option<(bool, bool)>> {
    Ok(sqlx::query_as(
        "SELECT fivesim_enabled, smspool_enabled FROM number_sell_settings WHERE id = 1",
    )
    .fetch_optional(db)
    .await?)
}

/// Seed is 5SIM on, SMSPool off. Both off is illegal (CHECK + PUT).
/// Recreate that seed if the row is missing or both flags are false so
/// operators can choose from a valid starting point.
pub async fn load(db: &PgPool) -> ApiResult<SellSettings> {
    if let Some((fivesim_enabled, smspool_enabled)) = fetch_row(db).await? {
        if fivesim_enabled || smspool_enabled {
            return Ok(SellSettings {
                fivesim_enabled,
                smspool_enabled,
            });
        }
    }
    sqlx::query(
        "INSERT INTO number_sell_settings (id, fivesim_enabled, smspool_enabled)
         VALUES (1, true, false)
         ON CONFLICT (id) DO UPDATE SET
           fivesim_enabled = true,
           smspool_enabled = false,
           updated_at = now()",
    )
    .execute(db)
    .await?;
    Ok(SEED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_database::IsolatedDatabase;

    #[test]
    fn stub_joins_enabled_live_suppliers() {
        let sell = SellSettings {
            fivesim_enabled: true,
            smspool_enabled: false,
        };
        assert_eq!(sell.source_providers(true), vec!["fivesim", "stub"]);
        assert_eq!(sell.source_providers(false), vec!["fivesim"]);
        assert!(sell.allows_live_fivesim_catalog(false));
        assert!(sell.allows_live_fivesim_catalog(true));
        let off = SellSettings {
            fivesim_enabled: false,
            smspool_enabled: true,
        };
        assert!(!off.allows_live_fivesim_catalog(true));
        assert!(off.allows_live_fivesim_catalog(false));
    }

    #[tokio::test]
    async fn load_recreates_seed_when_row_is_missing() {
        let database = IsolatedDatabase::new("sell_missing_row").await;
        sqlx::query("DELETE FROM number_sell_settings WHERE id = 1")
            .execute(&database.pool)
            .await
            .unwrap();
        let sell = load(&database.pool).await.unwrap();
        assert!(sell.fivesim_enabled);
        assert!(!sell.smspool_enabled);
        let again = load(&database.pool).await.unwrap();
        assert!(again.fivesim_enabled);
        assert!(!again.smspool_enabled);
        database.cleanup().await;
    }
}
