//! TRON adapter — the highest-volume rail in this market.
//!
//! TronGrid's HTTP API rather than JSON-RPC. TRC-20 transfers are ERC-20
//! semantics on a different address encoding, so the log shape matches EVM but
//! addresses are base58check with a `0x41` prefix and appear hex-encoded in
//! topics.

use crate::deposit::ObservedTransfer;
use crate::network::Network;
use crate::rpc::{JsonRpc, RpcResult};
use naivolt_core::Asset;
use rust_decimal::Decimal;
use serde::Deserialize;
use std::collections::HashMap;

pub struct TronAdapter {
    api: JsonRpc,
    keyed: bool,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // block_id feeds reorg checks once TRON reorg tracking lands
struct BlockResponse {
    block_header: BlockHeader,
    #[serde(rename = "blockID")]
    block_id: String,
}

#[derive(Debug, Deserialize)]
struct BlockHeader {
    raw_data: BlockRawData,
}

#[derive(Debug, Deserialize)]
struct BlockRawData {
    number: i64,
}

#[derive(Debug, Deserialize)]
struct Trc20Transfer {
    transaction_id: String,
    block_timestamp: i64,
    #[serde(default)]
    block: Option<i64>,
    from: String,
    to: String,
    value: String,
    token_info: TokenInfo,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // decimals come from token_contracts, not the API response
struct TokenInfo {
    address: String,
    decimals: u32,
}

#[derive(Debug, Deserialize)]
struct Trc20Response {
    #[serde(default)]
    data: Vec<Trc20Transfer>,
}

impl TronAdapter {
    /// TronGrid without a key is rate-limited per IP, and hits it within a few
    /// seconds of scanning even a handful of addresses. The key is optional so
    /// development works without one, and the pacing in the caller is what keeps
    /// that survivable.
    pub fn new(api_url: String, api_key: Option<String>) -> Self {
        let mut api = JsonRpc::new(api_url);
        let key = api_key.as_deref().filter(|k| !k.trim().is_empty());
        if let Some(key) = key {
            api = api.with_header("TRON-PRO-API-KEY", key);
        }
        Self {
            api,
            keyed: key.is_some(),
        }
    }

    /// Whether requests carry an API key, which decides how hard we may push.
    pub fn keyed(&self) -> bool {
        self.keyed
    }

    pub async fn head(&self) -> RpcResult<i64> {
        let block: BlockResponse = self.api.get("wallet/getnowblock").await?;
        Ok(block.block_header.raw_data.number)
    }

    /// TronGrid exposes no by-height block lookup on this endpoint, so reorg
    /// detection for TRON is deferred; 20 confirmations makes it very unlikely.
    #[allow(dead_code)]
    pub async fn block_hash(&self, _number: i64) -> RpcResult<Option<String>> {
        let block: BlockResponse = self.api.get("wallet/getnowblock").await?;
        Ok(Some(block.block_id))
    }

    /// The block a transaction was included in.
    ///
    /// The TRC-20 listing endpoint gives a timestamp and no height at all, so
    /// this is the only honest source for one. It matters more than it looks:
    /// confirmations are counted from the height, and a fabricated one leaves
    /// every TRON deposit sitting at zero confirmations forever, uncredited.
    pub async fn transaction_block(&self, tx_id: &str) -> RpcResult<Option<i64>> {
        let info: serde_json::Value = self
            .api
            .post(
                "wallet/gettransactioninfobyid",
                serde_json::json!({ "value": tx_id }),
            )
            .await?;

        Ok(info.get("blockNumber").and_then(|n| n.as_i64()))
    }

    /// TRC-20 transfers into one address.
    ///
    /// Queried per address rather than per block: TronGrid exposes an
    /// address-scoped endpoint but no efficient "all transfers in this block
    /// range" filter, and scanning every block's full transaction list would be
    /// far more requests for the same result.
    pub async fn transfers_to(
        &self,
        address: &str,
        since_timestamp_ms: i64,
        contracts: &HashMap<String, (Asset, u32)>,
    ) -> RpcResult<Vec<ObservedTransfer>> {
        let path = format!(
            "v1/accounts/{address}/transactions/trc20?only_to=true&min_timestamp={since_timestamp_ms}&limit=200"
        );
        let response: Trc20Response = self.api.get(&path).await?;

        let mut out = Vec::new();
        for transfer in response.data {
            // Only contracts we recognise. Anyone can deploy a token called
            // "USDT" and send a billion of it to a deposit address.
            let Some((asset, decimals)) = contracts.get(&transfer.token_info.address) else {
                continue;
            };

            if !transfer.to.eq_ignore_ascii_case(address) {
                continue;
            }

            let Some(amount) = scale_amount(&transfer.value, *decimals) else {
                continue;
            };

            // One extra request per transfer, and worth it: the alternative is a
            // height derived from the timestamp, which is not a height.
            let block_number = match self.transaction_block(&transfer.transaction_id).await {
                Ok(Some(block)) => block,
                Ok(None) => {
                    // Not yet in a block, or the node has not indexed it. It will
                    // be there on the next sweep.
                    tracing::debug!(tx = %transfer.transaction_id, "tron transfer has no block yet");
                    continue;
                }
                Err(err) => {
                    tracing::warn!(
                        tx = %transfer.transaction_id, error = %err,
                        "could not resolve the block for a tron transfer — skipping this sweep"
                    );
                    continue;
                }
            };

            out.push(ObservedTransfer {
                network: Network::Tron,
                tx_hash: transfer.transaction_id,
                // TronGrid does not surface a log index on this endpoint. The
                // transaction id is unique per transfer here because the query is
                // already scoped to one recipient, so a batch paying the same
                // address twice in one tx would collapse — rare enough to accept,
                // and it under-credits rather than double-credits.
                output_index: 0,
                to_address: transfer.to,
                asset: *asset,
                amount,
                block_number,
                block_hash: String::new(),
            });

            let _ = (transfer.from, transfer.block, transfer.block_timestamp);
        }

        Ok(out)
    }
}

/// Scale a decimal-string base-unit amount.
///
/// TronGrid returns `value` as a decimal string, not hex — a detail that would
/// otherwise be parsed with the EVM helper and silently produce garbage.
pub fn scale_amount(raw: &str, decimals: u32) -> Option<Decimal> {
    let base: u128 = raw.parse().ok()?;
    let mut value = Decimal::from_i128_with_scale(base as i128, 0);
    value.set_scale(decimals).ok()?;
    Some(value)
}

/// TRON base58check address to the hex form used in event topics.
#[allow(dead_code)] // used by the sweeper when it builds TRON transactions
pub fn base58_to_hex(address: &str) -> Option<String> {
    let decoded = bs58::decode(address).with_check(None).into_vec().ok()?;
    if decoded.len() != 21 || decoded[0] != 0x41 {
        return None;
    }
    Some(hex::encode(&decoded[1..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn decimal_string_amounts_scale_correctly() {
        // TronGrid sends decimal strings; the EVM path sends hex. Using the
        // wrong parser here yields a wildly wrong balance rather than an error.
        assert_eq!(scale_amount("100000000", 6), Some(dec!(100)));
        assert_eq!(scale_amount("1500000", 6), Some(dec!(1.5)));
        assert_eq!(scale_amount("1", 6), Some(dec!(0.000001)));
    }

    #[test]
    fn large_amounts_do_not_overflow_or_round() {
        // 1 billion USDT at 6 decimals.
        assert_eq!(scale_amount("1000000000000000", 6), Some(dec!(1000000000)));
    }

    #[test]
    fn non_numeric_values_are_rejected() {
        assert_eq!(scale_amount("", 6), None);
        assert_eq!(scale_amount("0x64", 6), None);
        assert_eq!(scale_amount("abc", 6), None);
    }

    #[test]
    fn tron_addresses_convert_to_topic_hex() {
        // The USDT contract on TRON.
        let hex = base58_to_hex("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t").unwrap();
        assert_eq!(hex.len(), 40);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn malformed_tron_addresses_are_rejected() {
        assert_eq!(base58_to_hex("not-an-address"), None);
        // Valid base58check but the wrong prefix byte, so not a TRON address.
        assert_eq!(base58_to_hex("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"), None);
    }
}
