//! The deposit pipeline: see → confirm → credit, and reverse on reorg.
//!
//! This is the module that decides when a user's money becomes real, so the
//! decisions are separated from the I/O and tested directly.
//!
//! Three properties matter more than anything else here:
//!
//! 1. **Idempotent.** Reprocessing a block must not credit twice. The unique key
//!    is `(chain, tx_hash, output_index)` — the hash alone is not enough, since
//!    one transaction can carry several deposits.
//! 2. **Confirmed before credited.** Crediting at zero confirmations credits
//!    money that can still vanish.
//! 3. **Reversible.** If a credited deposit is reorged away, the ledger must be
//!    corrected by a reversing journal — never by editing history.

use crate::network::Network;
use naivolt_core::Asset;
use naivolt_ledger::account::AccountKind;
use naivolt_ledger::journal::{JournalBuilder, JournalKind};
use rust_decimal::Decimal;
use uuid::Uuid;

/// A transfer the chain adapter found, before we decide what it means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedTransfer {
    pub network: Network,
    pub tx_hash: String,
    /// Log index for token transfers, vout for Bitcoin. One tx can carry several.
    pub output_index: i32,
    /// The deposit address it landed on.
    pub to_address: String,
    pub asset: Asset,
    /// Already scaled out of the chain's base units.
    pub amount: Decimal,
    pub block_number: i64,
    pub block_hash: String,
}

/// What should happen to a transfer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DepositAction {
    /// Record it, but not enough confirmations to credit yet.
    Record { confirmations: i64 },
    /// Threshold met — credit the ledger.
    Credit { confirmations: i64 },
    /// Below the minimum: sweeping it would cost more gas than it is worth.
    IgnoreDust { minimum: Decimal },
}

/// Decide what to do with an observed transfer.
///
/// `head` is the current chain tip. Confirmations are inclusive of the block the
/// transfer is in, matching how explorers count — a transfer in the head block
/// has one confirmation, not zero.
pub fn classify(transfer: &ObservedTransfer, head: i64) -> DepositAction {
    let minimum = minimum_deposit(transfer.asset);
    if transfer.amount < minimum {
        return DepositAction::IgnoreDust { minimum };
    }

    let confirmations = (head - transfer.block_number + 1).max(0);

    if confirmations >= transfer.network.min_confirmations() {
        DepositAction::Credit { confirmations }
    } else {
        DepositAction::Record { confirmations }
    }
}

/// Below these, the gas to sweep exceeds the deposit's value, so crediting it
/// would mean paying to move money we then owe the user.
pub fn minimum_deposit(asset: Asset) -> Decimal {
    use rust_decimal::prelude::FromPrimitive;
    let raw = match asset {
        Asset::Usdt | Asset::Usdc => 1.0,
        Asset::Btc => 0.0001,
        Asset::Eth => 0.005,
        Asset::Bnb => 0.01,
        Asset::Sol => 0.05,
        Asset::Trx => 50.0,
        Asset::Matic => 5.0,
        Asset::Ngn => 0.0,
    };
    Decimal::from_f64(raw).unwrap_or(Decimal::ZERO)
}

/// Build the journal that credits a confirmed deposit.
///
/// Custody debit, user credit — the coins are ours to hold, the value is theirs
/// to claim. The idempotency key is the deposit's natural key, so a replay of the
/// same transfer posts nothing.
pub fn credit_journal(
    deposit_id: Uuid,
    custody_account: Uuid,
    user_account: Uuid,
    asset: Asset,
    amount: Decimal,
    transfer: &ObservedTransfer,
) -> Result<naivolt_ledger::journal::Journal, naivolt_ledger::LedgerError> {
    JournalBuilder::new(
        JournalKind::DepositCredit,
        deposit_id.to_string(),
        idempotency_key("deposit", transfer),
    )
    .entry(
        custody_account,
        AccountKind::CustodyDepositAddrs,
        asset,
        amount,
    )
    .entry(user_account, AccountKind::UserCrypto, asset, -amount)
    .metadata(serde_json::json!({
        "network": transfer.network.as_str(),
        "txHash": transfer.tx_hash,
        "outputIndex": transfer.output_index,
        "blockNumber": transfer.block_number,
    }))
    .build()
}

/// Build the journal that undoes a credit after a reorg.
///
/// A reversal rather than a deletion: the ledger is append-only, and the fact
/// that we briefly credited this is part of the audit trail. The user's balance
/// returns to where it was, and the original journal stays visible.
pub fn reversal_journal(
    deposit_id: Uuid,
    custody_account: Uuid,
    user_account: Uuid,
    asset: Asset,
    amount: Decimal,
    transfer: &ObservedTransfer,
) -> Result<naivolt_ledger::journal::Journal, naivolt_ledger::LedgerError> {
    JournalBuilder::new(
        JournalKind::DepositReversal,
        deposit_id.to_string(),
        idempotency_key("reversal", transfer),
    )
    // Exactly the credit journal with the signs flipped.
    .entry(
        custody_account,
        AccountKind::CustodyDepositAddrs,
        asset,
        -amount,
    )
    .entry(user_account, AccountKind::UserCrypto, asset, amount)
    .metadata(serde_json::json!({
        "reason": "reorg",
        "network": transfer.network.as_str(),
        "txHash": transfer.tx_hash,
        "blockNumber": transfer.block_number,
    }))
    .build()
}

/// The natural key of a transfer, namespaced by what we are doing to it.
///
/// Namespacing matters: without it a reversal would collide with the credit it
/// reverses and silently post nothing, leaving the user credited for money that
/// no longer exists.
fn idempotency_key(kind: &str, transfer: &ObservedTransfer) -> String {
    format!(
        "{kind}:{}:{}:{}",
        transfer.network.as_str(),
        transfer.tx_hash,
        transfer.output_index
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn transfer(network: Network, amount: Decimal, block: i64) -> ObservedTransfer {
        ObservedTransfer {
            network,
            tx_hash: "0xabc".into(),
            output_index: 0,
            to_address: "0xdeadbeef".into(),
            asset: Asset::Usdt,
            amount,
            block_number: block,
            block_hash: "0xblock".into(),
        }
    }

    #[test]
    fn a_transfer_in_the_head_block_has_one_confirmation() {
        // Explorers count inclusively. Counting from zero would credit one block
        // later than the threshold intends on every network.
        let t = transfer(Network::Ethereum, dec!(100), 1000);
        assert_eq!(
            classify(&t, 1000),
            DepositAction::Record { confirmations: 1 }
        );
    }

    #[test]
    fn crediting_waits_for_the_networks_own_threshold() {
        let t = transfer(Network::Ethereum, dec!(100), 1000);

        // One short.
        assert!(matches!(
            classify(&t, 1010),
            DepositAction::Record { confirmations: 11 }
        ));
        // Exactly at the threshold.
        assert!(matches!(
            classify(&t, 1011),
            DepositAction::Credit { confirmations: 12 }
        ));
    }

    #[test]
    fn bsc_waits_longer_than_base_for_the_same_block_gap() {
        let gap = 15;
        let bsc = transfer(Network::Bsc, dec!(100), 1000);
        let base = transfer(Network::Base, dec!(100), 1000);

        assert!(matches!(classify(&bsc, 1000 + gap), DepositAction::Record { .. }));
        assert!(matches!(classify(&base, 1000 + gap), DepositAction::Credit { .. }));
    }

    #[test]
    fn dust_is_ignored_before_confirmations_are_considered() {
        // Sweeping 0.5 USDT costs more in gas than it is worth, so it must not
        // become a liability we then pay to move.
        let t = transfer(Network::Tron, dec!(0.5), 1000);
        assert!(matches!(
            classify(&t, 99_999),
            DepositAction::IgnoreDust { .. }
        ));
    }

    #[test]
    fn a_deposit_exactly_at_the_minimum_is_kept() {
        let t = transfer(Network::Tron, dec!(1), 1000);
        assert!(!matches!(
            classify(&t, 1000),
            DepositAction::IgnoreDust { .. }
        ));
    }

    #[test]
    fn confirmations_never_go_negative() {
        // A block number ahead of the reported head can happen mid-reorg or
        // across load-balanced RPC nodes at different heights.
        let t = transfer(Network::Ethereum, dec!(100), 1000);
        assert_eq!(
            classify(&t, 900),
            DepositAction::Record { confirmations: 0 }
        );
    }

    #[test]
    fn credit_journal_balances_and_moves_the_liability_the_right_way() {
        let t = transfer(Network::Tron, dec!(100), 1000);
        let journal = credit_journal(
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Asset::Usdt,
            dec!(100),
            &t,
        )
        .expect("credit journal must build");

        assert_eq!(journal.kind, JournalKind::DepositCredit);
        // Custody debited positive, user liability credited negative.
        let custody = journal
            .entries
            .iter()
            .find(|e| e.account_kind == AccountKind::CustodyDepositAddrs)
            .unwrap();
        let user = journal
            .entries
            .iter()
            .find(|e| e.account_kind == AccountKind::UserCrypto)
            .unwrap();
        assert_eq!(custody.amount, dec!(100));
        assert_eq!(user.amount, dec!(-100));
    }

    #[test]
    fn a_reversal_is_the_exact_inverse_of_its_credit() {
        let t = transfer(Network::Tron, dec!(100), 1000);
        let custody = Uuid::new_v4();
        let user = Uuid::new_v4();

        let credit =
            credit_journal(Uuid::new_v4(), custody, user, Asset::Usdt, dec!(100), &t).unwrap();
        let reversal =
            reversal_journal(Uuid::new_v4(), custody, user, Asset::Usdt, dec!(100), &t).unwrap();

        for entry in &credit.entries {
            let mirror = reversal
                .entries
                .iter()
                .find(|e| e.account_id == entry.account_id)
                .expect("every credited account must be reversed");
            assert_eq!(mirror.amount, -entry.amount);
        }
    }

    /// The bug this guards against would leave a user credited for money that no
    /// longer exists: if a reversal shared its key with the credit, posting it
    /// would be treated as a replay and silently do nothing.
    #[test]
    fn a_reversal_does_not_collide_with_the_credit_it_undoes() {
        let t = transfer(Network::Tron, dec!(100), 1000);
        let credit =
            credit_journal(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Asset::Usdt, dec!(100), &t)
                .unwrap();
        let reversal =
            reversal_journal(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Asset::Usdt, dec!(100), &t)
                .unwrap();

        assert_ne!(credit.idempotency_key, reversal.idempotency_key);
    }

    #[test]
    fn the_same_transfer_always_produces_the_same_key() {
        let t = transfer(Network::Tron, dec!(100), 1000);
        let a = credit_journal(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Asset::Usdt, dec!(100), &t).unwrap();
        let b = credit_journal(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Asset::Usdt, dec!(100), &t).unwrap();
        // Different deposit rows, same underlying transfer — the second must be
        // recognised as a replay.
        assert_eq!(a.idempotency_key, b.idempotency_key);
    }

    #[test]
    fn two_transfers_in_one_transaction_are_distinct() {
        // A batch contract call credits several users in one tx. Keying on the
        // hash alone would credit only the first.
        let mut a = transfer(Network::Tron, dec!(100), 1000);
        let mut b = a.clone();
        a.output_index = 0;
        b.output_index = 1;

        let ja = credit_journal(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Asset::Usdt, dec!(100), &a).unwrap();
        let jb = credit_journal(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Asset::Usdt, dec!(100), &b).unwrap();
        assert_ne!(ja.idempotency_key, jb.idempotency_key);
    }

    #[test]
    fn the_same_hash_on_two_networks_is_distinct() {
        // EVM chains share an address space and a replayed transaction can carry
        // the identical hash on two networks.
        let mut eth = transfer(Network::Ethereum, dec!(100), 1000);
        let mut bsc = transfer(Network::Bsc, dec!(100), 1000);
        eth.tx_hash = "0xsame".into();
        bsc.tx_hash = "0xsame".into();

        let je = credit_journal(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Asset::Usdt, dec!(100), &eth).unwrap();
        let jb = credit_journal(Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4(), Asset::Usdt, dec!(100), &bsc).unwrap();
        assert_ne!(je.idempotency_key, jb.idempotency_key);
    }
}
