//! Ledger accounts.
//!
//! # Sign convention
//!
//! Every entry is a signed amount and every journal sums to zero per asset
//! (classic double-entry, with debits positive and credits negative).
//!
//! That means for an ASSET account (something we hold), the raw sum is positive
//! when we hold more. For a LIABILITY account (something we owe a user), the raw
//! sum is *negative* when we owe more. Use [`AccountKind::user_facing_balance`]
//! rather than reading raw sums, so no caller ever shows a user a negative
//! balance because they forgot the convention.

use naivolt_core::Asset;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    // ----- LIABILITY: what we owe users -----
    /// A user's crypto balance. Never affected by sweeps.
    UserCrypto,
    /// A user's naira balance, spendable to a bank account.
    UserNgn,
    /// NGN reserved for an in-flight payout — left `UserNgn`, not yet paid out.
    NgnPayablePending,

    // ----- ASSET: what we actually hold -----
    /// Coins sitting in user deposit addresses, not yet swept.
    CustodyDepositAddrs,
    /// Coins in the hot wallet, available for outbound movement.
    CustodyHot,
    /// Coins in the master/cold wallet. Movement out requires dual control.
    CustodyMaster,
    /// Naira float held at the payout provider (Paystack balance).
    NgnFloat,

    // ----- REVENUE -----
    /// Margin earned on the spread between mid-market and our quoted rate.
    SpreadRevenue,
    /// Explicit fees charged to users.
    FeeRevenue,

    // ----- EXPENSE -----
    /// Gas/bandwidth burned funding and executing sweeps.
    GasExpense,
    /// Provider fees on payouts.
    PayoutFeeExpense,
}

impl AccountKind {
    /// Whether this account represents money owed to someone outside the company.
    pub const fn is_liability(self) -> bool {
        matches!(
            self,
            AccountKind::UserCrypto | AccountKind::UserNgn | AccountKind::NgnPayablePending
        )
    }

    /// Whether this account belongs to an individual user.
    pub const fn is_user_scoped(self) -> bool {
        matches!(self, AccountKind::UserCrypto | AccountKind::UserNgn)
    }

    /// Whether the account holds coins on a chain — i.e. is part of the custody
    /// plane that sweeping moves value around inside.
    pub const fn is_custody(self) -> bool {
        matches!(
            self,
            AccountKind::CustodyDepositAddrs
                | AccountKind::CustodyHot
                | AccountKind::CustodyMaster
        )
    }

    /// Convert a raw ledger sum into the number a human should see.
    ///
    /// Liabilities are stored negative; flip them so a user with ₦150,000 sees
    /// `150000`, not `-150000`.
    pub fn user_facing_balance(self, raw_sum: Decimal) -> Decimal {
        if self.is_liability() {
            -raw_sum
        } else {
            raw_sum
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            AccountKind::UserCrypto => "user_crypto",
            AccountKind::UserNgn => "user_ngn",
            AccountKind::NgnPayablePending => "ngn_payable_pending",
            AccountKind::CustodyDepositAddrs => "custody_deposit_addrs",
            AccountKind::CustodyHot => "custody_hot",
            AccountKind::CustodyMaster => "custody_master",
            AccountKind::NgnFloat => "ngn_float",
            AccountKind::SpreadRevenue => "spread_revenue",
            AccountKind::FeeRevenue => "fee_revenue",
            AccountKind::GasExpense => "gas_expense",
            AccountKind::PayoutFeeExpense => "payout_fee_expense",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerAccount {
    pub id: Uuid,
    pub kind: AccountKind,
    /// Set for user-scoped accounts, `None` for platform accounts.
    pub user_id: Option<Uuid>,
    pub asset: Asset,
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn liabilities_are_presented_positive() {
        // The ledger stores "we owe this user ₦150,000" as -150000.
        assert_eq!(
            AccountKind::UserNgn.user_facing_balance(dec!(-150000)),
            dec!(150000)
        );
        // Assets are shown as stored.
        assert_eq!(
            AccountKind::NgnFloat.user_facing_balance(dec!(150000)),
            dec!(150000)
        );
    }

    #[test]
    fn custody_accounts_are_never_user_scoped() {
        // If a custody account were user-scoped, sweeping it would look like a
        // change to that user's balance — the exact bug this design prevents.
        for kind in [
            AccountKind::CustodyDepositAddrs,
            AccountKind::CustodyHot,
            AccountKind::CustodyMaster,
        ] {
            assert!(kind.is_custody());
            assert!(!kind.is_user_scoped());
            assert!(!kind.is_liability());
        }
    }

    #[test]
    fn user_balances_are_liabilities_not_custody() {
        for kind in [AccountKind::UserCrypto, AccountKind::UserNgn] {
            assert!(kind.is_liability());
            assert!(kind.is_user_scoped());
            assert!(!kind.is_custody());
        }
    }
}
