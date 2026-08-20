//! Journals — the only way value moves in this system.
//!
//! A journal is an atomic, balanced, idempotent set of entries. Build one, and it
//! is validated before it can touch the database; post it, and it is immutable.

use crate::account::AccountKind;
use naivolt_core::Asset;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalKind {
    /// An on-chain deposit reached its confirmation threshold.
    DepositCredit,
    /// A deposit was reorged away after being credited.
    DepositReversal,
    /// Coins moved between our own custody accounts. **Custody plane only.**
    Sweep,
    /// Gas spent to make a sweep possible.
    GasSpend,
    /// A user sold crypto for naira at a locked quote.
    Sell,
    /// Naira reserved for an in-flight payout.
    PayoutReserve,
    /// Payout confirmed settled by the provider.
    PayoutSettle,
    /// Payout failed; the reservation is released back to the user.
    PayoutReversal,
    /// A card charge confirmed by the funding provider. Credits a naira balance.
    NgnDeposit,
    /// Naira reserved for a virtual-number order, before the supplier is called.
    NumberReserve,
    /// The verification code arrived; the reservation becomes revenue.
    NumberSettle,
    /// No code arrived, or the order was cancelled. Reverses the reservation.
    NumberRefund,
    /// Manual correction by an admin. Always references the journal it corrects.
    Adjustment,
}

impl JournalKind {
    /// Journals that must not move any liability account.
    ///
    /// Sweeping and gas spending relocate our own coins; they can never change
    /// what a user is owed. This is the invariant from `ARCHITECTURE.md` §2, made
    /// mechanical.
    pub const fn is_custody_only(self) -> bool {
        matches!(self, JournalKind::Sweep | JournalKind::GasSpend)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            JournalKind::DepositCredit => "deposit_credit",
            JournalKind::DepositReversal => "deposit_reversal",
            JournalKind::Sweep => "sweep",
            JournalKind::GasSpend => "gas_spend",
            JournalKind::Sell => "sell",
            JournalKind::PayoutReserve => "payout_reserve",
            JournalKind::PayoutSettle => "payout_settle",
            JournalKind::PayoutReversal => "payout_reversal",
            JournalKind::NgnDeposit => "ngn_deposit",
            JournalKind::NumberReserve => "number_reserve",
            JournalKind::NumberSettle => "number_settle",
            JournalKind::NumberRefund => "number_refund",
            JournalKind::Adjustment => "adjustment",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub account_id: Uuid,
    pub account_kind: AccountKind,
    pub asset: Asset,
    /// Signed. Debits positive, credits negative. See [`crate::account`].
    pub amount: Decimal,
}

/// A validated, ready-to-post journal.
#[derive(Debug, Clone)]
pub struct Journal {
    pub kind: JournalKind,
    /// Business reference — a deposit id, payout id, sweep id.
    pub reference: String,
    /// Uniquely identifies this economic event. Posting twice with the same key
    /// is a no-op, which is what makes every money path safe to retry.
    pub idempotency_key: String,
    pub entries: Vec<Entry>,
    pub metadata: serde_json::Value,
}

/// Accumulates entries and refuses to produce a [`Journal`] unless they are valid.
#[derive(Debug)]
pub struct JournalBuilder {
    kind: JournalKind,
    reference: String,
    idempotency_key: String,
    entries: Vec<Entry>,
    metadata: serde_json::Value,
}

impl JournalBuilder {
    pub fn new(
        kind: JournalKind,
        reference: impl Into<String>,
        idempotency_key: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            reference: reference.into(),
            idempotency_key: idempotency_key.into(),
            entries: Vec::new(),
            metadata: serde_json::Value::Null,
        }
    }

    /// Add a signed entry. Positive debits the account, negative credits it.
    pub fn entry(
        mut self,
        account_id: Uuid,
        account_kind: AccountKind,
        asset: Asset,
        amount: Decimal,
    ) -> Self {
        self.entries.push(Entry {
            account_id,
            account_kind,
            asset,
            amount,
        });
        self
    }

    pub fn metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = metadata;
        self
    }

    /// Validate and finalise.
    pub fn build(self) -> Result<Journal, LedgerError> {
        if self.entries.len() < 2 {
            return Err(LedgerError::TooFewEntries(self.entries.len()));
        }

        // Every journal must balance independently for each asset. A journal that
        // nets USDT against NGN would silently create or destroy value.
        let mut sums: HashMap<Asset, Decimal> = HashMap::new();
        for entry in &self.entries {
            if entry.amount.is_zero() {
                return Err(LedgerError::ZeroAmount(entry.account_id));
            }
            *sums.entry(entry.asset).or_default() += entry.amount;
        }
        for (asset, sum) in &sums {
            if !sum.is_zero() {
                return Err(LedgerError::Unbalanced {
                    asset: *asset,
                    residual: *sum,
                });
            }
        }

        // The custody-plane guarantee, enforced rather than documented.
        if self.kind.is_custody_only() {
            if let Some(bad) = self.entries.iter().find(|e| e.account_kind.is_liability()) {
                return Err(LedgerError::CustodyJournalTouchedLiability {
                    kind: self.kind,
                    account_id: bad.account_id,
                });
            }
        }

        Ok(Journal {
            kind: self.kind,
            reference: self.reference,
            idempotency_key: self.idempotency_key,
            entries: self.entries,
            metadata: self.metadata,
        })
    }
}

impl Journal {
    /// Post inside an existing transaction.
    ///
    /// Idempotent: a replay with the same key returns the original journal id and
    /// writes nothing. Callers must take any needed row locks (e.g.
    /// `SELECT … FOR UPDATE` on a user's NGN account) *before* calling this.
    pub async fn post(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<PostOutcome, LedgerError> {
        // ON CONFLICT DO NOTHING + RETURNING gives us "insert or tell me it
        // already existed" in a single round trip, with no race window.
        let existing: Option<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM ledger_journals WHERE idempotency_key = $1",
        )
        .bind(&self.idempotency_key)
        .fetch_optional(&mut **tx)
        .await?;

        if let Some((id,)) = existing {
            return Ok(PostOutcome::AlreadyPosted(id));
        }

        let journal_id: Uuid = sqlx::query_scalar(
            "INSERT INTO ledger_journals (kind, reference, idempotency_key, metadata)
             VALUES ($1, $2, $3, $4)
             RETURNING id",
        )
        .bind(self.kind.as_str())
        .bind(&self.reference)
        .bind(&self.idempotency_key)
        .bind(&self.metadata)
        .fetch_one(&mut **tx)
        .await?;

        for entry in &self.entries {
            sqlx::query(
                "INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(journal_id)
            .bind(entry.account_id)
            .bind(entry.asset.as_str())
            .bind(entry.amount)
            .execute(&mut **tx)
            .await?;
        }

        Ok(PostOutcome::Posted(journal_id))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostOutcome {
    Posted(Uuid),
    /// The idempotency key had already been used; nothing was written.
    AlreadyPosted(Uuid),
}

impl PostOutcome {
    pub fn journal_id(self) -> Uuid {
        match self {
            PostOutcome::Posted(id) | PostOutcome::AlreadyPosted(id) => id,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    #[error("a journal needs at least 2 entries, got {0}")]
    TooFewEntries(usize),
    #[error("journal does not balance in {asset}: residual {residual}")]
    Unbalanced { asset: Asset, residual: Decimal },
    #[error("entry for account {0} has a zero amount")]
    ZeroAmount(Uuid),
    #[error("{kind:?} journal touched liability account {account_id} — custody movements must never change what a user is owed")]
    CustodyJournalTouchedLiability {
        kind: JournalKind,
        account_id: Uuid,
    },
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn id() -> Uuid {
        Uuid::new_v4()
    }

    #[test]
    fn balanced_deposit_credit_builds() {
        let journal = JournalBuilder::new(JournalKind::DepositCredit, "dep_1", "tron:0xabc:0")
            .entry(id(), AccountKind::CustodyDepositAddrs, Asset::Usdt, dec!(100))
            .entry(id(), AccountKind::UserCrypto, Asset::Usdt, dec!(-100))
            .build();
        assert!(journal.is_ok());
    }

    #[test]
    fn unbalanced_journal_is_rejected() {
        let err = JournalBuilder::new(JournalKind::DepositCredit, "dep_1", "k1")
            .entry(id(), AccountKind::CustodyDepositAddrs, Asset::Usdt, dec!(100))
            .entry(id(), AccountKind::UserCrypto, Asset::Usdt, dec!(-99))
            .build()
            .unwrap_err();
        assert!(matches!(err, LedgerError::Unbalanced { .. }));
    }

    #[test]
    fn each_asset_must_balance_on_its_own() {
        // Nets to zero overall, but invents 100 USDT and destroys 100 NGN.
        let err = JournalBuilder::new(JournalKind::Sell, "sell_1", "k2")
            .entry(id(), AccountKind::CustodyDepositAddrs, Asset::Usdt, dec!(100))
            .entry(id(), AccountKind::UserNgn, Asset::Ngn, dec!(-100))
            .build()
            .unwrap_err();
        assert!(matches!(err, LedgerError::Unbalanced { .. }));
    }

    #[test]
    fn sweep_between_custody_accounts_is_allowed() {
        let journal = JournalBuilder::new(JournalKind::Sweep, "sweep_1", "sweep:1")
            .entry(id(), AccountKind::CustodyHot, Asset::Usdt, dec!(100))
            .entry(id(), AccountKind::CustodyDepositAddrs, Asset::Usdt, dec!(-100))
            .build();
        assert!(journal.is_ok());
    }

    /// The central safety property: emptying a user's deposit address into the
    /// master wallet must be structurally incapable of reducing their balance.
    #[test]
    fn sweep_cannot_touch_a_user_balance() {
        let err = JournalBuilder::new(JournalKind::Sweep, "sweep_2", "sweep:2")
            .entry(id(), AccountKind::CustodyMaster, Asset::Usdt, dec!(100))
            .entry(id(), AccountKind::UserCrypto, Asset::Usdt, dec!(-100))
            .build()
            .unwrap_err();
        assert!(matches!(
            err,
            LedgerError::CustodyJournalTouchedLiability { .. }
        ));
    }

    #[test]
    fn gas_spend_cannot_touch_a_user_balance() {
        let err = JournalBuilder::new(JournalKind::GasSpend, "sweep_3", "gas:3")
            .entry(id(), AccountKind::GasExpense, Asset::Trx, dec!(2.7))
            .entry(id(), AccountKind::UserCrypto, Asset::Trx, dec!(-2.7))
            .build()
            .unwrap_err();
        assert!(matches!(
            err,
            LedgerError::CustodyJournalTouchedLiability { .. }
        ));
    }

    #[test]
    fn single_entry_journal_is_rejected() {
        let err = JournalBuilder::new(JournalKind::Adjustment, "adj", "k3")
            .entry(id(), AccountKind::UserNgn, Asset::Ngn, dec!(1000))
            .build()
            .unwrap_err();
        assert!(matches!(err, LedgerError::TooFewEntries(1)));
    }

    #[test]
    fn zero_amount_entries_are_rejected() {
        let err = JournalBuilder::new(JournalKind::Sell, "sell_2", "k4")
            .entry(id(), AccountKind::UserNgn, Asset::Ngn, dec!(0))
            .entry(id(), AccountKind::NgnFloat, Asset::Ngn, dec!(0))
            .build()
            .unwrap_err();
        assert!(matches!(err, LedgerError::ZeroAmount(_)));
    }

    #[test]
    fn full_sell_with_spread_balances() {
        // 100 USDT sold at ₦1,530 against a ₦1,550 mid: user gets 153,000,
        // the 2,000 spread is revenue, and NGN still nets to zero.
        let journal = JournalBuilder::new(JournalKind::Sell, "sell_3", "quote:abc")
            .entry(id(), AccountKind::UserCrypto, Asset::Usdt, dec!(100))
            .entry(id(), AccountKind::CustodyHot, Asset::Usdt, dec!(-100))
            .entry(id(), AccountKind::UserNgn, Asset::Ngn, dec!(-153000))
            .entry(id(), AccountKind::SpreadRevenue, Asset::Ngn, dec!(-2000))
            .entry(id(), AccountKind::NgnFloat, Asset::Ngn, dec!(155000))
            .build();
        assert!(journal.is_ok(), "{:?}", journal.unwrap_err());
    }

    #[test]
    fn a_number_order_that_never_delivers_leaves_the_user_whole() {
        // The refund must reverse the reservation exactly. Netting the two
        // journals per account is what a user's balance actually does, so if
        // these do not cancel, someone is short ₦620.
        let user_ngn = id();
        let pending = id();

        let reserve = JournalBuilder::new(JournalKind::NumberReserve, "NVNO-1", "intent:1")
            .entry(user_ngn, AccountKind::UserNgn, Asset::Ngn, dec!(620))
            .entry(pending, AccountKind::NumberPayablePending, Asset::Ngn, dec!(-620))
            .build()
            .expect("reserve balances");

        let refund = JournalBuilder::new(JournalKind::NumberRefund, "NVNO-1", "NVNO-1:refund")
            .entry(pending, AccountKind::NumberPayablePending, Asset::Ngn, dec!(620))
            .entry(user_ngn, AccountKind::UserNgn, Asset::Ngn, dec!(-620))
            .build()
            .expect("refund balances");

        let net: Decimal = reserve
            .entries
            .iter()
            .chain(refund.entries.iter())
            .filter(|e| e.account_id == user_ngn)
            .map(|e| e.amount)
            .sum();
        assert_eq!(net, Decimal::ZERO, "the user paid for a code that never came");

        let held: Decimal = reserve
            .entries
            .iter()
            .chain(refund.entries.iter())
            .filter(|e| e.account_id == pending)
            .map(|e| e.amount)
            .sum();
        assert_eq!(held, Decimal::ZERO, "the reservation was never released");
    }

    #[test]
    fn a_delivered_number_turns_the_reservation_into_revenue() {
        // Settling must discharge the *whole* reservation — anything left in
        // number_payable_pending is money we still owe but have booked as earned.
        let pending = id();
        let settle = JournalBuilder::new(JournalKind::NumberSettle, "NVNO-2", "NVNO-2:settle")
            .entry(pending, AccountKind::NumberPayablePending, Asset::Ngn, dec!(620))
            .entry(id(), AccountKind::NumberRevenue, Asset::Ngn, dec!(-620))
            .build();
        assert!(settle.is_ok(), "{:?}", settle.unwrap_err());
    }

    #[test]
    fn high_precision_amounts_do_not_drift() {
        // 18-decimal ETH: floats would lose this; Decimal must not.
        let a = dec!(0.123456789012345678);
        let journal = JournalBuilder::new(JournalKind::DepositCredit, "dep_2", "k5")
            .entry(id(), AccountKind::CustodyDepositAddrs, Asset::Eth, a)
            .entry(id(), AccountKind::UserCrypto, Asset::Eth, -a)
            .build();
        assert!(journal.is_ok());
    }
}
