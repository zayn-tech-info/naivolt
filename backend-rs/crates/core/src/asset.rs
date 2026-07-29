//! Assets the platform holds on behalf of users, plus NGN.

use crate::chain::Chain;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssetKind {
    /// The chain's own gas token.
    Native,
    /// A contract-issued token (ERC-20 / TRC-20 / SPL).
    Token,
    /// Nigerian naira — a ledger-only asset, no chain.
    Fiat,
}

/// A ledger asset. Balances are always denominated in one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Asset {
    Ngn,
    Btc,
    Eth,
    Bnb,
    Matic,
    Trx,
    Sol,
    /// USDT — the network it lives on is tracked per deposit, not per asset.
    Usdt,
    Usdc,
}

impl Asset {
    pub const fn kind(self) -> AssetKind {
        match self {
            Asset::Ngn => AssetKind::Fiat,
            Asset::Usdt | Asset::Usdc => AssetKind::Token,
            _ => AssetKind::Native,
        }
    }

    /// On-chain decimal precision. NGN is stored to 4dp in the ledger but
    /// presented to users as 2dp.
    pub const fn decimals(self) -> u32 {
        match self {
            Asset::Ngn => 4,
            Asset::Btc => 8,
            Asset::Eth | Asset::Bnb | Asset::Matic => 18,
            Asset::Trx => 6,
            Asset::Sol => 9,
            Asset::Usdt | Asset::Usdc => 6,
        }
    }

    /// The gas token that must be present for a sweep to succeed.
    ///
    /// Returns `None` for Bitcoin (fee comes out of the inputs) and for NGN.
    pub const fn gas_asset(self, chain: Chain) -> Option<Asset> {
        match chain {
            Chain::Bitcoin => None,
            Chain::Evm => Some(Asset::Eth), // per-network native; resolved by the sweeper
            Chain::Tron => Some(Asset::Trx),
            Chain::Solana => Some(Asset::Sol),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Asset::Ngn => "NGN",
            Asset::Btc => "BTC",
            Asset::Eth => "ETH",
            Asset::Bnb => "BNB",
            Asset::Matic => "MATIC",
            Asset::Trx => "TRX",
            Asset::Sol => "SOL",
            Asset::Usdt => "USDT",
            Asset::Usdc => "USDC",
        }
    }
}

impl fmt::Display for Asset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Asset {
    type Err = UnknownAsset;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_uppercase().as_str() {
            "NGN" => Ok(Asset::Ngn),
            "BTC" => Ok(Asset::Btc),
            "ETH" => Ok(Asset::Eth),
            "BNB" => Ok(Asset::Bnb),
            "MATIC" => Ok(Asset::Matic),
            "TRX" => Ok(Asset::Trx),
            "SOL" => Ok(Asset::Sol),
            "USDT" => Ok(Asset::Usdt),
            "USDC" => Ok(Asset::Usdc),
            _ => Err(UnknownAsset(s.to_owned())),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("unknown asset: {0}")]
pub struct UnknownAsset(pub String);
