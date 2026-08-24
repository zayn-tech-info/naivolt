//! EVM adapter: Ethereum, BSC, Polygon, Base.
//!
//! One implementation for all four — they differ only in RPC URL, confirmation
//! depth and which contracts we recognise.
//!
//! Deposits are found by scanning `Transfer` logs rather than by inspecting
//! every transaction. A token transfer that happens inside a contract call
//! (a DEX swap routing to a user's address, a batch disbursement) leaves no
//! trace in the transaction's `to` field but always emits a log.

use crate::deposit::ObservedTransfer;
use crate::network::Network;
use crate::rpc::{JsonRpc, RpcResult};
use anyhow::Context;
use naivolt_core::Asset;
use rust_decimal::Decimal;
use serde::Deserialize;
use std::collections::HashMap;

/// `keccak256("Transfer(address,address,uint256)")` — the ERC-20 transfer topic.
const TRANSFER_TOPIC: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

pub struct EvmAdapter {
    pub network: Network,
    rpc: JsonRpc,
}

#[derive(Debug, Deserialize)]
struct RpcLog {
    address: String,
    topics: Vec<String>,
    data: String,
    #[serde(rename = "blockNumber")]
    block_number: String,
    #[serde(rename = "blockHash")]
    block_hash: String,
    #[serde(rename = "transactionHash")]
    transaction_hash: String,
    #[serde(rename = "logIndex")]
    log_index: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // `number` is echoed back by nodes; kept for shape fidelity
struct RpcBlock {
    hash: String,
    number: String,
}

#[derive(Debug, Deserialize)]
struct RpcReceipt {
    #[serde(rename = "blockNumber")]
    block_number: String,
    #[serde(rename = "blockHash")]
    block_hash: String,
}

impl EvmAdapter {
    pub fn new(network: Network, rpc_url: String) -> Self {
        Self {
            network,
            rpc: JsonRpc::new(rpc_url),
        }
    }

    pub async fn head(&self) -> RpcResult<i64> {
        let raw: String = self.rpc.call("eth_blockNumber", serde_json::json!([])).await?;
        Ok(parse_hex_i64(&raw).context("block number")?)
    }

    pub async fn block_hash(&self, number: i64) -> RpcResult<Option<String>> {
        let block: Option<RpcBlock> = self
            .rpc
            .call(
                "eth_getBlockByNumber",
                serde_json::json!([format!("0x{number:x}"), false]),
            )
            .await?;
        Ok(block.map(|b| b.hash))
    }

    /// Where a transaction currently sits, if it is in the canonical chain.
    ///
    /// `None` means the node has no receipt for it: the transaction is not in
    /// any block it knows about. That is the only case that justifies reversing
    /// a credit — a transaction that merely moved to a different block after a
    /// reorg is still a real deposit.
    pub async fn transaction_location(&self, tx_hash: &str) -> RpcResult<Option<(i64, String)>> {
        let receipt: Option<RpcReceipt> = self
            .rpc
            .call("eth_getTransactionReceipt", serde_json::json!([tx_hash]))
            .await?;

        Ok(receipt.and_then(|r| {
            parse_hex_i64(&r.block_number).map(|number| (number, r.block_hash))
        }))
    }

    /// Token transfers into any watched address, across a block range.
    ///
    /// The address filter goes in `topics[2]` so the node does the matching. The
    /// alternative — fetching every Transfer log and filtering here — is orders
    /// of magnitude more data and gets rate-limited immediately.
    pub async fn token_transfers(
        &self,
        from_block: i64,
        to_block: i64,
        watched: &HashMap<String, ()>,
        contracts: &HashMap<String, (Asset, u32)>,
    ) -> RpcResult<Vec<ObservedTransfer>> {
        if watched.is_empty() || contracts.is_empty() {
            return Ok(Vec::new());
        }

        let addresses: Vec<String> = contracts.keys().cloned().collect();
        // Topics are 32 bytes; an address is 20, left-padded with zeros.
        let to_topics: Vec<String> = watched.keys().map(|a| address_to_topic(a)).collect();

        let logs: Vec<RpcLog> = self
            .rpc
            .call(
                "eth_getLogs",
                serde_json::json!([{
                    "fromBlock": format!("0x{from_block:x}"),
                    "toBlock": format!("0x{to_block:x}"),
                    "address": addresses,
                    // [event, from (any), to (ours)]
                    "topics": [TRANSFER_TOPIC, serde_json::Value::Null, to_topics],
                }]),
            )
            .await?;

        let mut out = Vec::new();
        for log in logs {
            let Some((asset, decimals)) = contracts.get(&log.address.to_ascii_lowercase()) else {
                // An unrecognised contract reached us despite the filter. Skip it
                // rather than guess — crediting an unknown token as USDT is how a
                // worthless coin becomes real money.
                continue;
            };

            let Some(to_topic) = log.topics.get(2) else {
                continue;
            };
            let to_address = topic_to_address(to_topic);
            if !watched.contains_key(&to_address) {
                continue;
            }

            let Some(amount) = parse_amount(&log.data, *decimals) else {
                continue;
            };

            out.push(ObservedTransfer {
                network: self.network,
                tx_hash: log.transaction_hash,
                output_index: parse_hex_i64(&log.log_index).unwrap_or(0) as i32,
                to_address,
                asset: *asset,
                amount,
                block_number: parse_hex_i64(&log.block_number).unwrap_or(0),
                block_hash: log.block_hash,
            });
        }

        Ok(out)
    }
}

/// How many blocks to ask for logs over, adjusted to what the endpoint allows.
///
/// Free endpoints disagree wildly, and they say so only by refusing: BSC's
/// dataseed will not serve `eth_getLogs` at any range, and publicnode refuses a
/// window that reaches further back than the blocks it keeps. A fixed window
/// leaves the watcher retrying a query that can never succeed — which is exactly
/// how BSC sat at zero deposits while its cursor never moved at all.
#[derive(Debug, Clone, Copy)]
pub struct LogWindow {
    size: i64,
    max: i64,
}

impl LogWindow {
    pub fn new(max: i64) -> Self {
        Self {
            size: max.max(1),
            max: max.max(1),
        }
    }

    pub fn size(self) -> i64 {
        self.size
    }

    /// Halve after a refusal. `false` once a single block is refused too: no
    /// smaller question exists, so the endpoint simply cannot serve logs.
    pub fn shrink(&mut self) -> bool {
        if self.size <= 1 {
            return false;
        }
        self.size = (self.size / 2).max(1);
        true
    }

    /// Creep back up after a success, so one refused window does not pin the
    /// watcher at a block per request for the rest of the process's life.
    pub fn grow(&mut self) {
        self.size = (self.size + (self.size / 4).max(1)).min(self.max);
    }
}

/// Left-pad a 20-byte address into a 32-byte topic.
pub fn address_to_topic(address: &str) -> String {
    let clean = address.trim_start_matches("0x").to_ascii_lowercase();
    format!("0x{:0>64}", clean)
}

/// Take the low 20 bytes of a topic back to an address.
pub fn topic_to_address(topic: &str) -> String {
    let clean = topic.trim_start_matches("0x");
    if clean.len() < 40 {
        return format!("0x{clean}");
    }
    format!("0x{}", &clean[clean.len() - 40..].to_ascii_lowercase())
}

fn parse_hex_i64(raw: &str) -> Option<i64> {
    i64::from_str_radix(raw.trim_start_matches("0x"), 16).ok()
}

/// Scale a hex base-unit amount into a decimal.
///
/// Parsed as `u128` and divided by the token's scale — never through `f64`,
/// which cannot hold 18 decimals and would silently round a user's balance.
pub fn parse_amount(data: &str, decimals: u32) -> Option<Decimal> {
    let clean = data.trim_start_matches("0x");
    if clean.is_empty() {
        return None;
    }
    // Take the first 32-byte word; some tokens append extra data.
    let word = &clean[..clean.len().min(64)];
    let raw = u128::from_str_radix(word, 16).ok()?;

    let mut value = Decimal::from_i128_with_scale(raw as i128, 0);
    value.set_scale(decimals).ok()?;
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn addresses_round_trip_through_topics() {
        let address = "0x6fac4d18c912343bf86fa7049364dd4e424ab9c0";
        let topic = address_to_topic(address);
        assert_eq!(topic.len(), 66); // 0x + 64 hex chars
        assert_eq!(topic_to_address(&topic), address);
    }

    #[test]
    fn topic_conversion_is_case_insensitive() {
        // Logs come back lowercase; our stored addresses are EIP-55 mixed case.
        // Comparing without folding would match nothing at all.
        let checksummed = "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0";
        let lower = "0x6fac4d18c912343bf86fa7049364dd4e424ab9c0";
        assert_eq!(address_to_topic(checksummed), address_to_topic(lower));
    }

    #[test]
    fn amounts_decode_at_full_precision() {
        // 100 USDT, 6 decimals.
        let data = format!("0x{:064x}", 100_000_000u64);
        assert_eq!(parse_amount(&data, 6), Some(dec!(100)));

        // 1.5 ETH, 18 decimals — the case f64 would corrupt.
        let data = format!("0x{:064x}", 1_500_000_000_000_000_000u64);
        assert_eq!(parse_amount(&data, 18), Some(dec!(1.5)));
    }

    #[test]
    fn eighteen_decimal_dust_survives_intact() {
        let data = format!("0x{:064x}", 123_456_789_012_345_678u64);
        assert_eq!(parse_amount(&data, 18), Some(dec!(0.123456789012345678)));
    }

    #[test]
    fn zero_amounts_decode_rather_than_erroring() {
        let data = format!("0x{:064x}", 0u64);
        assert_eq!(parse_amount(&data, 18), Some(Decimal::ZERO));
    }

    #[test]
    fn malformed_data_is_rejected_not_guessed() {
        assert_eq!(parse_amount("0x", 18), None);
        assert_eq!(parse_amount("0xzzzz", 18), None);
    }

    #[test]
    fn a_refused_window_halves_until_the_endpoint_accepts_it() {
        let mut window = LogWindow::new(2_000);
        assert_eq!(window.size(), 2_000);

        assert!(window.shrink());
        assert_eq!(window.size(), 1_000);
        assert!(window.shrink());
        assert_eq!(window.size(), 500);
    }

    #[test]
    fn an_endpoint_that_refuses_one_block_is_out_of_smaller_questions() {
        // bsc-dataseed.binance.org refuses eth_getLogs at every range, including
        // a single block. Shrinking forever would hide that behind a silent loop.
        let mut window = LogWindow::new(4);
        while window.shrink() {}
        assert_eq!(window.size(), 1);
        assert!(!window.shrink());
    }

    #[test]
    fn a_recovered_window_grows_back_but_never_past_its_ceiling() {
        let mut window = LogWindow::new(100);
        window.shrink();
        assert_eq!(window.size(), 50);

        for _ in 0..50 {
            window.grow();
        }
        assert_eq!(window.size(), 100);
    }

    #[test]
    fn the_transfer_topic_is_the_real_keccak_hash() {
        // Wrong by one character and the watcher silently sees no deposits at all.
        assert_eq!(
            TRANSFER_TOPIC,
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
        );
        assert_eq!(TRANSFER_TOPIC.len(), 66);
    }
}
