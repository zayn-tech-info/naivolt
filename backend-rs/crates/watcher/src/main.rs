//! Chain watchers.
//!
//! One task per network, each independent: a stalled Bitcoin node must not stop
//! TRON deposits from crediting. A task that panics is restarted rather than
//! taking the process down with it.

#![forbid(unsafe_code)]

mod deposit;
mod evm;
mod network;
mod rpc;
mod store;
mod tron;

use anyhow::{Context, Result};
use deposit::{classify, DepositAction, ObservedTransfer};
use naivolt_core::Asset;
use network::Network;
use rpc::RpcError;
use sqlx::postgres::PgPoolOptions;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use store::Store;

/// Blocks per `eth_getLogs` before any endpoint-specific narrowing.
const MAX_LOG_WINDOW: i64 = 2_000;

/// Consecutive failed log scans before the network's watcher gives up and is
/// restarted by its supervisor.
const MAX_TRANSIENT_FAILURES: u32 = 5;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is not set")?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .context("connecting to postgres")?;

    let store = Arc::new(Store::new(pool));

    // Only networks with a configured RPC endpoint. Starting a watcher without
    // one would log errors forever while silently missing every deposit.
    let mut handles = Vec::new();
    for net in Network::ALL {
        let Ok(url) = std::env::var(net.rpc_env_var()) else {
            tracing::warn!(network = %net, var = net.rpc_env_var(), "no RPC configured — not watching");
            continue;
        };
        if url.trim().is_empty() {
            continue;
        }

        let store = Arc::clone(&store);
        handles.push(tokio::spawn(async move {
            supervise(net, url, store).await;
        }));
    }

    if handles.is_empty() {
        anyhow::bail!("no networks configured — set at least one *_RPC_URL");
    }

    tracing::info!(count = handles.len(), "watchers started");
    futures_join(handles).await;
    Ok(())
}

async fn futures_join(handles: Vec<tokio::task::JoinHandle<()>>) {
    for handle in handles {
        let _ = handle.await;
    }
}

/// Keep a network's watcher running.
///
/// A crash here means deposits stop being seen, so the loop restarts rather than
/// exiting — with a delay, so a persistently broken endpoint does not spin.
async fn supervise(network: Network, rpc_url: String, store: Arc<Store>) {
    // Backoff grows with consecutive failures: an endpoint that is misconfigured
    // rather than merely flaky would otherwise be hammered every ten seconds for
    // as long as the process runs.
    const MIN_BACKOFF: Duration = Duration::from_secs(10);
    const MAX_BACKOFF: Duration = Duration::from_secs(300);
    let mut backoff = MIN_BACKOFF;

    loop {
        match watch(network, &rpc_url, &store).await {
            Ok(()) => {
                tracing::warn!(%network, "watcher exited cleanly, restarting");
                backoff = MIN_BACKOFF;
            }
            Err(err) => {
                tracing::error!(
                    %network, error = ?err, retry_in_s = backoff.as_secs(),
                    "watcher failed, restarting"
                );
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
        tokio::time::sleep(backoff).await;
    }
}

async fn watch(network: Network, rpc_url: &str, store: &Store) -> Result<()> {
    match network {
        Network::Tron => watch_tron(network, rpc_url, store).await,
        n if n.is_evm() => watch_evm(network, rpc_url, store).await,
        // Bitcoin and Solana adapters land in the next task; refusing here is
        // better than a loop that silently sees nothing.
        other => {
            anyhow::bail!("no adapter for {other} yet")
        }
    }
}

async fn watch_evm(network: Network, rpc_url: &str, store: &Store) -> Result<()> {
    let adapter = evm::EvmAdapter::new(network, rpc_url.to_owned());
    let contracts = store.token_contracts(network).await?;

    let head = adapter.head().await?;
    let mut cursor = match store.cursor(network).await? {
        // Resume behind the last processed block. Reprocessing is idempotent,
        // and starting exactly at the cursor would miss a deposit that was seen
        // but not yet credited when the process died.
        Some((last, _)) => (last - network.rescan_depth()).max(0),
        None => head - network.rescan_depth(),
    };

    tracing::info!(%network, head, cursor, contracts = contracts.len(), "watching");

    // Bounded window: providers cap eth_getLogs ranges, and a cold start
    // thousands of blocks behind would otherwise ask for all of it at once. The
    // cap differs per endpoint and is only ever discovered by being refused.
    let mut window = evm::LogWindow::new(MAX_LOG_WINDOW);
    let mut transient_failures = 0u32;

    loop {
        let head = adapter.head().await?;

        if cursor >= head {
            tokio::time::sleep(Duration::from_millis(network.poll_interval_ms())).await;
            continue;
        }

        let to = (cursor + window.size()).min(head);
        let saturated = to - cursor >= window.size();
        // Overlap the previous pass: see `Network::scan_overlap`.
        let from = (cursor + 1 - network.scan_overlap()).max(0);

        let watched = store.watched_addresses(network).await?;
        let watched_keys: HashMap<String, ()> =
            watched.keys().map(|k| (k.clone(), ())).collect();

        let transfers = match adapter
            .token_transfers(from, to, &watched_keys, &contracts)
            .await
        {
            Ok(transfers) => {
                transient_failures = 0;
                // Only widen when the window was actually full; growing on a
                // one-block query near the tip would just re-provoke the refusal.
                if saturated {
                    window.grow();
                }
                transfers
            }
            Err(RpcError::RangeRefused(reason)) => {
                if window.shrink() {
                    tracing::warn!(
                        %network, window = window.size(), %reason,
                        "endpoint refused the block range, narrowing"
                    );
                    continue;
                }
                // Every deposit on this network is invisible until this is fixed,
                // so say what is wrong rather than retrying a refusal forever.
                anyhow::bail!(
                    "{network}: endpoint refuses eth_getLogs even for a single block ({reason}) \
                     — no deposits can be seen; point {} at an endpoint that serves logs",
                    network.rpc_env_var()
                );
            }
            Err(err) => {
                // One failed query is not a reason to tear down the network's
                // watcher and re-read every address and contract. Several in a
                // row is: something is wrong with the endpoint, and the restart
                // backs off further each time.
                transient_failures += 1;
                if transient_failures >= MAX_TRANSIENT_FAILURES {
                    return Err(err.into());
                }
                tracing::warn!(
                    %network, attempt = transient_failures, error = %err,
                    "log scan failed, retrying the same window"
                );
                tokio::time::sleep(Duration::from_millis(network.poll_interval_ms())).await;
                continue;
            }
        };

        for transfer in &transfers {
            handle_transfer(store, transfer, head).await;
        }

        advance_pending(store, network, head).await?;
        check_reorgs(store, network, head, &adapter).await?;

        let hash = adapter.block_hash(to).await.ok().flatten();
        store.save_cursor(network, to, hash.as_deref()).await?;
        cursor = to;

        if to >= head {
            tokio::time::sleep(Duration::from_millis(network.poll_interval_ms())).await;
        }
    }
}

async fn watch_tron(network: Network, rpc_url: &str, store: &Store) -> Result<()> {
    let adapter = tron::TronAdapter::new(
        rpc_url.to_owned(),
        std::env::var("TRON_API_KEY").ok(),
    );
    let contracts = store.token_contracts(network).await?;

    // How hard TronGrid lets us push depends entirely on whether there is a key.
    // Unkeyed traffic is metered per IP and answers 429 within seconds of a tight
    // sweep — and slowing down costs nothing, because TRON waits 20 confirmations
    // (a full minute) before a deposit can be credited anyway.
    let (spacing, sweep_interval) = if adapter.keyed() {
        (Duration::from_millis(200), Duration::from_millis(network.poll_interval_ms()))
    } else {
        (Duration::from_secs(1), Duration::from_secs(15))
    };

    tracing::info!(
        %network, contracts = contracts.len(), keyed = adapter.keyed(),
        sweep_s = sweep_interval.as_secs(), "watching"
    );

    // The first sweep looks a day back so a restart cannot miss anything. Later
    // sweeps only need what has happened since, with slack for clock skew and for
    // transfers TronGrid indexes a little after they land.
    let mut since = (chrono::Utc::now() - chrono::Duration::days(1)).timestamp_millis();

    loop {
        let swept_at = chrono::Utc::now();
        let head = adapter.head().await?;
        let watched = store.watched_addresses(network).await?;

        for address in watched.keys() {
            // One request per address per sweep, spaced out. Firing the whole
            // address book at TronGrid as fast as the loop allows earns a 429 on
            // every single one, which is exactly what the first live run did.
            tokio::time::sleep(spacing).await;

            match adapter.transfers_to(address, since, &contracts).await {
                Ok(transfers) => {
                    for transfer in &transfers {
                        handle_transfer(store, transfer, head).await;
                    }
                }
                Err(err) => {
                    // One address failing must not stop the others.
                    tracing::warn!(%address, error = %err, "tron address scan failed");
                }
            }
        }

        advance_pending(store, network, head).await?;
        store.save_cursor(network, head, None).await?;

        since = (swept_at - chrono::Duration::minutes(5)).timestamp_millis();
        tokio::time::sleep(sweep_interval).await;
    }
}

/// Record a transfer and credit it if it is deep enough.
async fn handle_transfer(store: &Store, transfer: &ObservedTransfer, head: i64) {
    let Ok(Some((wallet_id, user_id))) = store
        .wallet_for(transfer.network, &transfer.to_address)
        .await
    else {
        // Not one of ours. Reaching here means the node's filter returned
        // something we did not ask for.
        return;
    };

    let action = classify(transfer, head);
    let (status, confirmations) = match action {
        DepositAction::IgnoreDust { minimum } => {
            tracing::debug!(
                amount = %transfer.amount, %minimum, asset = %transfer.asset,
                "ignoring dust deposit"
            );
            ("ignored", 0)
        }
        DepositAction::Record { confirmations } => ("seen", confirmations),
        DepositAction::Credit { confirmations } => ("seen", confirmations),
    };

    let Ok((deposit_id, existing_status)) = store
        .upsert_deposit(transfer, user_id, wallet_id, confirmations, status)
        .await
    else {
        tracing::error!(tx = %transfer.tx_hash, "could not record deposit");
        return;
    };

    // Already settled one way or the other; nothing to do.
    if existing_status == "confirmed" || existing_status == "reversed" {
        return;
    }

    if matches!(action, DepositAction::Credit { .. }) {
        if let Err(err) = store.credit_deposit(deposit_id, transfer).await {
            tracing::error!(%deposit_id, error = ?err, "crediting failed");
        }
    }
}

/// Move already-seen deposits toward crediting as the chain advances.
///
/// Necessary because a deposit first seen at one confirmation is never revisited
/// by the log scan — the block it is in has already been passed.
async fn advance_pending(store: &Store, network: Network, head: i64) -> Result<()> {
    for pending in store.pending_deposits(network).await? {
        let confirmations = (head - pending.block_number + 1).max(0);

        if confirmations < network.min_confirmations() {
            store.set_confirmations(pending.id, confirmations).await?;
            continue;
        }

        let Ok(asset) = pending.asset.parse::<Asset>() else {
            continue;
        };

        let transfer = ObservedTransfer {
            network,
            tx_hash: pending.tx_hash.clone(),
            output_index: pending.output_index,
            to_address: String::new(),
            asset,
            amount: pending.amount,
            block_number: pending.block_number,
            block_hash: pending.block_hash.clone().unwrap_or_default(),
        };

        if let Err(err) = store.credit_deposit(pending.id, &transfer).await {
            tracing::error!(deposit = %pending.id, error = ?err, "crediting failed");
        }
    }
    Ok(())
}

/// Detect credited deposits whose block no longer exists on the canonical chain.
///
/// Only the recent window is checked: beyond the reorg depth, a chain
/// reorganisation deep enough to matter is a far larger incident than this loop.
async fn check_reorgs(
    store: &Store,
    network: Network,
    head: i64,
    adapter: &evm::EvmAdapter,
) -> Result<()> {
    let window_start = head - network.rescan_depth();
    let mut checked: HashMap<i64, Option<String>> = HashMap::new();

    for deposit in store.reorg_window(network, window_start).await? {
        let Some(recorded_hash) = deposit.block_hash.clone() else {
            continue;
        };
        if recorded_hash.is_empty() {
            continue;
        }

        let current = match checked.get(&deposit.block_number) {
            Some(hash) => hash.clone(),
            None => {
                let hash = adapter.block_hash(deposit.block_number).await.ok().flatten();
                checked.insert(deposit.block_number, hash.clone());
                hash
            }
        };

        let Some(current) = current else { continue };
        if current.eq_ignore_ascii_case(&recorded_hash) {
            continue;
        }

        // The block at this height is no longer the one we credited from — which
        // is not the same as the deposit being gone. A reorg almost always
        // re-includes the same transactions in the replacement blocks, so ask
        // where this transaction is now before taking money off anyone.
        match adapter.transaction_location(&deposit.tx_hash).await {
            Ok(Some((block_number, block_hash))) => {
                tracing::warn!(
                    deposit = %deposit.id, from = deposit.block_number, to = block_number,
                    %network, "deposit moved blocks in a reorg — the credit stands"
                );
                store
                    .relocate_deposit(deposit.id, block_number, &block_hash)
                    .await?;
                continue;
            }
            Ok(None) => {}
            Err(err) => {
                // An RPC that failed to answer is not evidence the deposit is
                // gone. Reversing on it would debit a user for a network blip.
                tracing::warn!(
                    deposit = %deposit.id, error = %err,
                    "could not confirm whether a reorged deposit still exists — leaving it credited"
                );
                continue;
            }
        }

        let Ok(asset) = deposit.asset.parse::<Asset>() else {
            continue;
        };
        let transfer = ObservedTransfer {
            network,
            tx_hash: deposit.tx_hash.clone(),
            output_index: deposit.output_index,
            to_address: String::new(),
            asset,
            amount: deposit.amount,
            block_number: deposit.block_number,
            block_hash: recorded_hash,
        };

        tracing::error!(
            deposit = %deposit.id, block = deposit.block_number, %network,
            "reorg detected — reversing credited deposit"
        );
        store.reverse_deposit(deposit.id, &transfer).await?;
    }

    Ok(())
}

fn init_tracing() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,naivolt_watcher=debug"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .init();
}
