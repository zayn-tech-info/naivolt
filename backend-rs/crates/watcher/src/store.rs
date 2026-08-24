//! Database access for the watcher.
//!
//! Every write here is idempotent or guarded, because the watcher reprocesses
//! blocks routinely — on restart, after a reorg, and whenever an RPC call is
//! retried.

use crate::deposit::{credit_journal, reversal_journal, ObservedTransfer};
use crate::network::Network;
use anyhow::{Context, Result};
use naivolt_core::Asset;
use naivolt_ledger::account::AccountKind;
use rust_decimal::Decimal;
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;

pub struct Store {
    pool: PgPool,
}

impl Store {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Where to resume from, and the hash we last saw at that height.
    pub async fn cursor(&self, network: Network) -> Result<Option<(i64, Option<String>)>> {
        let row: Option<(i64, Option<String>)> = sqlx::query_as(
            "SELECT last_block, last_block_hash FROM chain_cursors WHERE network = $1",
        )
        .bind(network.as_str())
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn save_cursor(
        &self,
        network: Network,
        block: i64,
        block_hash: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO chain_cursors (network, chain, last_block, last_block_hash, updated_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (network) DO UPDATE
                SET last_block = EXCLUDED.last_block,
                    last_block_hash = EXCLUDED.last_block_hash,
                    updated_at = now()",
        )
        .bind(network.as_str())
        .bind(network.chain().as_str())
        .bind(block)
        .bind(block_hash)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Contracts we credit on this network, keyed by contract address.
    pub async fn token_contracts(
        &self,
        network: Network,
    ) -> Result<HashMap<String, (Asset, u32)>> {
        let rows: Vec<(Option<String>, String, i16)> = sqlx::query_as(
            "SELECT contract, asset, decimals FROM token_contracts
              WHERE network = $1 AND is_active AND contract IS NOT NULL",
        )
        .bind(network.as_str())
        .fetch_all(&self.pool)
        .await?;

        let mut map = HashMap::new();
        for (contract, asset, decimals) in rows {
            let Some(contract) = contract else { continue };
            let Ok(asset) = asset.parse::<Asset>() else {
                continue;
            };
            // EVM contracts are compared lowercased; TRON base58 is case-sensitive
            // and already canonical.
            let key = if network.is_evm() {
                contract.to_ascii_lowercase()
            } else {
                contract
            };
            map.insert(key, (asset, decimals as u32));
        }
        Ok(map)
    }

    /// Every deposit address on this chain, mapped to its owning user.
    ///
    /// Held in memory: matching a log against the database per-log would be one
    /// query per transfer on a busy block.
    pub async fn watched_addresses(&self, network: Network) -> Result<HashMap<String, Uuid>> {
        let rows: Vec<(String, Uuid)> =
            sqlx::query_as("SELECT address, user_id FROM wallets WHERE chain = $1")
                .bind(network.chain().as_str())
                .fetch_all(&self.pool)
                .await?;

        Ok(rows
            .into_iter()
            .map(|(address, user)| {
                let key = if network.is_evm() {
                    address.to_ascii_lowercase()
                } else {
                    address
                };
                (key, user)
            })
            .collect())
    }

    /// Record a transfer, or return the existing row if we have seen it before.
    ///
    /// The `ON CONFLICT` is what makes reprocessing a block safe.
    pub async fn upsert_deposit(
        &self,
        transfer: &ObservedTransfer,
        user_id: Uuid,
        wallet_id: Uuid,
        confirmations: i64,
        status: &str,
    ) -> Result<(Uuid, String)> {
        let row: (Uuid, String) = sqlx::query_as(
            "INSERT INTO deposits
                (user_id, wallet_id, chain, network, asset, tx_hash, output_index,
                 amount, block_number, block_hash, confirmations, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (chain, tx_hash, output_index) DO UPDATE
                SET confirmations = EXCLUDED.confirmations
             RETURNING id, status",
        )
        .bind(user_id)
        .bind(wallet_id)
        .bind(transfer.network.chain().as_str())
        .bind(transfer.network.as_str())
        .bind(transfer.asset.as_str())
        .bind(&transfer.tx_hash)
        .bind(transfer.output_index)
        .bind(transfer.amount)
        .bind(transfer.block_number)
        .bind(&transfer.block_hash)
        .bind(confirmations as i32)
        .bind(status)
        .fetch_one(&self.pool)
        .await
        .context("upsert deposit")?;

        Ok(row)
    }

    pub async fn wallet_for(&self, network: Network, address: &str) -> Result<Option<(Uuid, Uuid)>> {
        let row: Option<(Uuid, Uuid)> = sqlx::query_as(
            "SELECT id, user_id FROM wallets WHERE chain = $1 AND lower(address) = lower($2)",
        )
        .bind(network.chain().as_str())
        .bind(address)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    /// Credit a confirmed deposit, once.
    ///
    /// The status guard in the `UPDATE` is the second line of defence behind the
    /// journal's idempotency key: even if this ran twice concurrently, only one
    /// transaction can move the row out of its pre-credit status.
    pub async fn credit_deposit(&self, deposit_id: Uuid, transfer: &ObservedTransfer) -> Result<bool> {
        let mut tx = self.pool.begin().await?;

        let row: Option<(Uuid, Decimal, String)> = sqlx::query_as(
            "SELECT user_id, amount, status FROM deposits WHERE id = $1 FOR UPDATE",
        )
        .bind(deposit_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some((user_id, amount, status)) = row else {
            return Ok(false);
        };
        if status == "confirmed" || status == "reversed" {
            return Ok(false);
        }

        let custody = account_id(&mut tx, AccountKind::CustodyDepositAddrs, None, transfer.asset).await?;
        let user_account =
            account_id(&mut tx, AccountKind::UserCrypto, Some(user_id), transfer.asset).await?;

        let journal = credit_journal(
            deposit_id,
            custody,
            user_account,
            transfer.asset,
            amount,
            transfer,
        )?;
        let outcome = journal.post(&mut tx).await?;

        sqlx::query(
            "UPDATE deposits SET status = 'confirmed', credited_journal_id = $1 WHERE id = $2",
        )
        .bind(outcome.journal_id())
        .bind(deposit_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        tracing::info!(
            %deposit_id, %user_id, asset = %transfer.asset, %amount,
            tx_hash = %transfer.tx_hash, "deposit credited"
        );
        Ok(true)
    }

    /// Undo a credit whose transaction vanished in a reorg.
    pub async fn reverse_deposit(&self, deposit_id: Uuid, transfer: &ObservedTransfer) -> Result<bool> {
        let mut tx = self.pool.begin().await?;

        let row: Option<(Uuid, Decimal, String)> = sqlx::query_as(
            "SELECT user_id, amount, status FROM deposits WHERE id = $1 FOR UPDATE",
        )
        .bind(deposit_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some((user_id, amount, status)) = row else {
            return Ok(false);
        };
        // Only a credited deposit needs undoing. One never credited has no
        // ledger effect to reverse.
        if status != "confirmed" {
            return Ok(false);
        }

        let custody = account_id(&mut tx, AccountKind::CustodyDepositAddrs, None, transfer.asset).await?;
        let user_account =
            account_id(&mut tx, AccountKind::UserCrypto, Some(user_id), transfer.asset).await?;

        let journal = reversal_journal(
            deposit_id,
            custody,
            user_account,
            transfer.asset,
            amount,
            transfer,
        )?;
        let outcome = journal.post(&mut tx).await?;

        sqlx::query(
            "UPDATE deposits
                SET status = 'reversed', reversed_journal_id = $1, reversed_at = now()
              WHERE id = $2",
        )
        .bind(outcome.journal_id())
        .bind(deposit_id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        tracing::error!(
            %deposit_id, %user_id, asset = %transfer.asset, %amount,
            tx_hash = %transfer.tx_hash,
            "deposit REVERSED after reorg — user balance reduced"
        );
        Ok(true)
    }

    /// Deposits recorded but not yet credited, for confirmation tracking.
    pub async fn pending_deposits(&self, network: Network) -> Result<Vec<PendingDeposit>> {
        let rows: Vec<PendingDeposit> = sqlx::query_as(
            "SELECT id, tx_hash, output_index, asset, amount, block_number, block_hash
               FROM deposits
              WHERE network = $1 AND status IN ('seen', 'confirming')
              ORDER BY block_number",
        )
        .bind(network.as_str())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Credited deposits still shallow enough to be reorged out.
    pub async fn reorg_window(&self, network: Network, from_block: i64) -> Result<Vec<PendingDeposit>> {
        let rows: Vec<PendingDeposit> = sqlx::query_as(
            "SELECT id, tx_hash, output_index, asset, amount, block_number, block_hash
               FROM deposits
              WHERE network = $1 AND status = 'confirmed' AND block_number >= $2",
        )
        .bind(network.as_str())
        .bind(from_block)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// Follow a deposit whose transaction was re-included in a different block.
    ///
    /// No ledger effect: the money arrived and is still there, it is simply at a
    /// new height. Recording the move is what stops the next reorg sweep from
    /// comparing against a hash the chain no longer has and reversing a deposit
    /// that never went anywhere.
    pub async fn relocate_deposit(
        &self,
        deposit_id: Uuid,
        block_number: i64,
        block_hash: &str,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE deposits SET block_number = $1, block_hash = $2 WHERE id = $3",
        )
        .bind(block_number)
        .bind(block_hash)
        .bind(deposit_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_confirmations(&self, deposit_id: Uuid, confirmations: i64) -> Result<()> {
        sqlx::query("UPDATE deposits SET confirmations = $1, status = 'confirming' WHERE id = $2 AND status = 'seen'")
            .bind(confirmations as i32)
            .bind(deposit_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PendingDeposit {
    pub id: Uuid,
    pub tx_hash: String,
    pub output_index: i32,
    pub asset: String,
    pub amount: Decimal,
    pub block_number: i64,
    pub block_hash: Option<String>,
}

/// Find or create a ledger account.
async fn account_id(
    tx: &mut Transaction<'_, Postgres>,
    kind: AccountKind,
    user_id: Option<Uuid>,
    asset: Asset,
) -> Result<Uuid> {
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM ledger_accounts
          WHERE kind = $1 AND asset = $2 AND user_id IS NOT DISTINCT FROM $3",
    )
    .bind(kind.as_str())
    .bind(asset.as_str())
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?
    {
        return Ok(id);
    }

    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO ledger_accounts (kind, user_id, asset) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING id",
    )
    .bind(kind.as_str())
    .bind(user_id)
    .bind(asset.as_str())
    .fetch_optional(&mut **tx)
    .await?;

    match id {
        Some(id) => Ok(id),
        // Lost the race to a concurrent insert; the row now exists.
        None => sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM ledger_accounts
              WHERE kind = $1 AND asset = $2 AND user_id IS NOT DISTINCT FROM $3",
        )
        .bind(kind.as_str())
        .bind(asset.as_str())
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await
        .context("ledger account"),
    }
}
