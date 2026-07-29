//! Supported chains and their key-derivation parameters.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// Elliptic curve used for a chain's keys.
///
/// This distinction matters for derivation: secp256k1 chains use standard BIP-32
/// (public derivation possible, non-hardened indices allowed), while ed25519
/// chains must use SLIP-0010 with *hardened indices only*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Curve {
    Secp256k1,
    Ed25519,
}

/// A chain we derive deposit addresses for.
///
/// Note that all EVM networks share a single [`Chain::Evm`] variant: they use the
/// same derivation path and therefore the same address on every network, so one
/// wallet row covers Ethereum, BSC, Polygon and Base. The *network* a deposit
/// arrived on is recorded on the deposit, not on the wallet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Chain {
    Bitcoin,
    Evm,
    Tron,
    Solana,
}

impl Chain {
    pub const ALL: [Chain; 4] = [Chain::Bitcoin, Chain::Evm, Chain::Tron, Chain::Solana];

    pub const fn curve(self) -> Curve {
        match self {
            Chain::Solana => Curve::Ed25519,
            _ => Curve::Secp256k1,
        }
    }

    /// SLIP-44 coin type.
    pub const fn coin_type(self) -> u32 {
        match self {
            Chain::Bitcoin => 0,
            Chain::Evm => 60,
            Chain::Tron => 195,
            Chain::Solana => 501,
        }
    }

    /// BIP-32 derivation path for a user's address index.
    ///
    /// Bitcoin uses BIP-84 (native segwit). Solana follows the Phantom/Solana-CLI
    /// convention of a fully hardened `m/44'/501'/{i}'/0'` path.
    pub fn derivation_path(self, index: u32) -> String {
        match self {
            Chain::Bitcoin => format!("m/84'/0'/0'/0/{index}"),
            Chain::Evm => format!("m/44'/60'/0'/0/{index}"),
            Chain::Tron => format!("m/44'/195'/0'/0/{index}"),
            Chain::Solana => format!("m/44'/501'/{index}'/0'"),
        }
    }

    /// Confirmations before a deposit is credited to the ledger.
    ///
    /// EVM is the most conservative of the networks sharing the variant
    /// (Ethereum); per-network thresholds are applied by the watcher.
    pub const fn min_confirmations(self) -> u32 {
        match self {
            Chain::Bitcoin => 2,
            Chain::Evm => 12,
            Chain::Tron => 20,
            Chain::Solana => 1, // "finalized" commitment is already irreversible
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Chain::Bitcoin => "bitcoin",
            Chain::Evm => "evm",
            Chain::Tron => "tron",
            Chain::Solana => "solana",
        }
    }
}

impl fmt::Display for Chain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Chain {
    type Err = UnknownChain;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "bitcoin" | "btc" => Ok(Chain::Bitcoin),
            "evm" | "ethereum" | "eth" | "bsc" | "polygon" | "base" => Ok(Chain::Evm),
            "tron" | "trx" => Ok(Chain::Tron),
            "solana" | "sol" => Ok(Chain::Solana),
            _ => Err(UnknownChain(s.to_owned())),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("unknown chain: {0}")]
pub struct UnknownChain(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solana_path_is_fully_hardened() {
        // ed25519 cannot do non-hardened derivation; the path must reflect that.
        assert_eq!(Chain::Solana.derivation_path(7), "m/44'/501'/7'/0'");
        assert_eq!(Chain::Solana.curve(), Curve::Ed25519);
    }

    #[test]
    fn evm_index_varies_in_last_position() {
        assert_eq!(Chain::Evm.derivation_path(0), "m/44'/60'/0'/0/0");
        assert_eq!(Chain::Evm.derivation_path(42), "m/44'/60'/0'/0/42");
    }

    #[test]
    fn chain_roundtrips_through_string() {
        for chain in Chain::ALL {
            assert_eq!(chain.as_str().parse::<Chain>().unwrap(), chain);
        }
    }
}
