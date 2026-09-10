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

pub async fn load(db: &PgPool) -> ApiResult<SellSettings> {
    let row: (bool, bool) = sqlx::query_as(
        "SELECT fivesim_enabled, smspool_enabled FROM number_sell_settings WHERE id = 1",
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("number_sell_settings row is missing")))?;
    Ok(SellSettings {
        fivesim_enabled: row.0,
        smspool_enabled: row.1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
