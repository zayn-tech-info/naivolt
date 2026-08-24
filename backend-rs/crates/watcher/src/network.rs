//! Networks, as distinct from chain families.
//!
//! `Chain::Evm` covers four networks that share one address but have entirely
//! different block times, reorg depths and RPC endpoints. Everything the watcher
//! does is per-network; only key derivation is per-chain.

use naivolt_core::Chain;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Tron,
    Ethereum,
    Bsc,
    Polygon,
    Base,
    Bitcoin,
    Solana,
}

impl Network {
    pub const ALL: [Network; 7] = [
        Network::Tron,
        Network::Ethereum,
        Network::Bsc,
        Network::Polygon,
        Network::Base,
        Network::Bitcoin,
        Network::Solana,
    ];

    /// The chain family whose wallet row holds this network's address.
    pub const fn chain(self) -> Chain {
        match self {
            Network::Tron => Chain::Tron,
            Network::Ethereum | Network::Bsc | Network::Polygon | Network::Base => Chain::Evm,
            Network::Bitcoin => Chain::Bitcoin,
            Network::Solana => Chain::Solana,
        }
    }

    /// Confirmations before crediting.
    ///
    /// Set by reorg risk, not by block time. BSC and Polygon produce blocks fast
    /// but reorg deeper and more often than Ethereum, so they wait for more —
    /// crediting early means crediting money that can vanish.
    pub const fn min_confirmations(self) -> i64 {
        match self {
            Network::Bitcoin => 2,
            Network::Ethereum => 12,
            Network::Bsc => 20,
            Network::Polygon => 20,
            Network::Base => 10,
            Network::Tron => 20,
            // Solana's "finalized" commitment is already irreversible, so the
            // watcher queries at that commitment and needs no further wait.
            Network::Solana => 1,
        }
    }

    /// How far back to re-scan on startup.
    ///
    /// Deliberately deeper than the confirmation threshold: a deposit seen but
    /// not yet credited when the process died must be found again, and a reorg
    /// that happened while we were down must be detectable.
    pub const fn rescan_depth(self) -> i64 {
        self.min_confirmations() * 3
    }

    /// Blocks re-queried on every pass, on top of the new ones.
    ///
    /// A public endpoint is a pool of nodes, and the one that answers
    /// `eth_getLogs` can be a block or two behind the one that just reported the
    /// head — it says so only sometimes. Without an overlap, a block a lagging
    /// backend answered for with fewer logs than it holds is never asked about
    /// again, and the deposit in it is lost silently. Re-asking costs one filter
    /// query and nothing else: insertion is idempotent.
    pub const fn scan_overlap(self) -> i64 {
        match self {
            // Twelve-second blocks: a lagging node is at most a block behind.
            Network::Ethereum => 3,
            // Sub-two-second blocks, so a node a moment behind is several blocks
            // behind.
            Network::Bsc | Network::Polygon | Network::Base => 10,
            // Not log-scanned.
            Network::Tron | Network::Bitcoin | Network::Solana => 0,
        }
    }

    /// Polling interval in milliseconds, roughly one block.
    pub const fn poll_interval_ms(self) -> u64 {
        match self {
            Network::Bitcoin => 30_000,
            Network::Ethereum => 6_000,
            Network::Bsc => 2_000,
            Network::Polygon => 2_000,
            Network::Base => 2_000,
            Network::Tron => 3_000,
            Network::Solana => 1_000,
        }
    }

    pub const fn is_evm(self) -> bool {
        matches!(
            self,
            Network::Ethereum | Network::Bsc | Network::Polygon | Network::Base
        )
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Network::Tron => "tron",
            Network::Ethereum => "ethereum",
            Network::Bsc => "bsc",
            Network::Polygon => "polygon",
            Network::Base => "base",
            Network::Bitcoin => "bitcoin",
            Network::Solana => "solana",
        }
    }

    /// Environment variable holding this network's RPC URL.
    pub const fn rpc_env_var(self) -> &'static str {
        match self {
            Network::Tron => "TRON_RPC_URL",
            Network::Ethereum => "ETHEREUM_RPC_URL",
            Network::Bsc => "BSC_RPC_URL",
            Network::Polygon => "POLYGON_RPC_URL",
            Network::Base => "BASE_RPC_URL",
            Network::Bitcoin => "BITCOIN_RPC_URL",
            Network::Solana => "SOLANA_RPC_URL",
        }
    }
}

impl fmt::Display for Network {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Network {
    type Err = UnknownNetwork;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "tron" => Ok(Network::Tron),
            "ethereum" | "eth" => Ok(Network::Ethereum),
            "bsc" | "bnb" => Ok(Network::Bsc),
            "polygon" | "matic" => Ok(Network::Polygon),
            "base" => Ok(Network::Base),
            "bitcoin" | "btc" => Ok(Network::Bitcoin),
            "solana" | "sol" => Ok(Network::Solana),
            _ => Err(UnknownNetwork(s.to_owned())),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("unknown network: {0}")]
pub struct UnknownNetwork(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_evm_networks_share_the_evm_chain() {
        for network in [
            Network::Ethereum,
            Network::Bsc,
            Network::Polygon,
            Network::Base,
        ] {
            assert!(network.is_evm());
            assert_eq!(network.chain(), Chain::Evm);
        }
    }

    #[test]
    fn each_evm_network_keeps_its_own_confirmation_depth() {
        // The whole reason cursors are per-network: these must not collapse to
        // one shared value.
        assert_eq!(Network::Ethereum.min_confirmations(), 12);
        assert_eq!(Network::Bsc.min_confirmations(), 20);
        assert_eq!(Network::Base.min_confirmations(), 10);
    }

    #[test]
    fn rescan_reaches_past_the_confirmation_window() {
        // A deposit seen but uncredited at crash time must still be in range.
        for network in Network::ALL {
            assert!(
                network.rescan_depth() > network.min_confirmations(),
                "{network} would miss in-flight deposits on restart"
            );
        }
    }

    #[test]
    fn every_log_scanned_network_re_asks_for_recent_blocks() {
        // The overlap is what covers an endpoint that answered from a node a
        // block behind. Zero here means a missed deposit is missed forever.
        for network in Network::ALL {
            if network.is_evm() {
                assert!(network.scan_overlap() > 0, "{network} scans without overlap");
                // But never so far back that a restart's rescan is the smaller
                // window — that would make the overlap the real cursor.
                assert!(network.scan_overlap() < network.rescan_depth());
            }
        }
    }

    #[test]
    fn networks_round_trip_through_strings() {
        for network in Network::ALL {
            assert_eq!(network.as_str().parse::<Network>().unwrap(), network);
        }
    }

    #[test]
    fn every_network_has_a_distinct_rpc_var() {
        let vars: std::collections::HashSet<_> =
            Network::ALL.iter().map(|n| n.rpc_env_var()).collect();
        assert_eq!(vars.len(), Network::ALL.len());
    }
}
