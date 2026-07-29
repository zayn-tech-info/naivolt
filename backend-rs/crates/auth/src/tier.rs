//! KYC tiers.
//!
//! Signup asks for nothing. The wall goes up at **withdrawal**, where value
//! leaves the platform into the banking system and the AML obligation attaches —
//! not at the door. See `docs/ARCHITECTURE.md` §10.3.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KycTier {
    /// Signup only. Full app access except moving naira to a bank.
    Tier0,
    /// BVN verified and name/DOB matched.
    Tier1,
    /// Tier 1 plus NIN and selfie liveness.
    Tier2,
    /// Tier 2 plus proof of address.
    Tier3,
}

impl KycTier {
    pub const fn from_i16(v: i16) -> Option<Self> {
        match v {
            0 => Some(KycTier::Tier0),
            1 => Some(KycTier::Tier1),
            2 => Some(KycTier::Tier2),
            3 => Some(KycTier::Tier3),
            _ => None,
        }
    }

    pub const fn as_i16(self) -> i16 {
        match self {
            KycTier::Tier0 => 0,
            KycTier::Tier1 => 1,
            KycTier::Tier2 => 2,
            KycTier::Tier3 => 3,
        }
    }

    /// Naira that may be withdrawn per rolling 24 hours.
    ///
    /// `None` means withdrawal is not permitted at all.
    pub fn daily_payout_cap(self) -> Option<Decimal> {
        match self {
            KycTier::Tier0 => None,
            KycTier::Tier1 => Some(Decimal::from(50_000)),
            KycTier::Tier2 => Some(Decimal::from(500_000)),
            KycTier::Tier3 => Some(Decimal::from(5_000_000)),
        }
    }

    pub fn can_withdraw(self) -> bool {
        self.daily_payout_cap().is_some()
    }

    /// Deposits are open at every tier — inbound crypto is screened on arrival
    /// and cannot leave without KYC, so accepting it costs nothing.
    pub const fn can_deposit(self) -> bool {
        true
    }

    /// Selling crypto for naira moves value only inside our own ledger and
    /// creates no external obligation, so it is not gated.
    pub const fn can_sell(self) -> bool {
        true
    }

    /// What the user must provide to reach the next tier, for the in-app prompt.
    pub const fn next_step(self) -> Option<&'static str> {
        match self {
            KycTier::Tier0 => Some("Verify your BVN to withdraw to your bank account"),
            KycTier::Tier1 => Some("Add your NIN and take a selfie to raise your limit"),
            KycTier::Tier2 => Some("Upload proof of address to raise your limit"),
            KycTier::Tier3 => None,
        }
    }
}

/// Why a withdrawal was refused. Distinguishing these matters for the UI: one is
/// "verify yourself", the other is "come back tomorrow".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayoutCheck {
    Allowed,
    /// Tier 0 — no KYC at all yet.
    KycRequired { next_step: &'static str },
    /// KYC is fine, but this would breach the rolling daily cap.
    ExceedsDailyCap {
        cap: Decimal,
        already_used: Decimal,
        remaining: Decimal,
    },
}

/// Decide whether a payout may proceed.
///
/// `used_today` is the sum already paid out in the rolling 24-hour window.
pub fn check_payout(tier: KycTier, amount: Decimal, used_today: Decimal) -> PayoutCheck {
    let Some(cap) = tier.daily_payout_cap() else {
        return PayoutCheck::KycRequired {
            next_step: tier.next_step().unwrap_or("Verify your identity"),
        };
    };

    let remaining = cap - used_today;
    if amount > remaining {
        return PayoutCheck::ExceedsDailyCap {
            cap,
            already_used: used_today,
            remaining: remaining.max(Decimal::ZERO),
        };
    }

    PayoutCheck::Allowed
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn tier0_can_use_everything_except_withdrawal() {
        let t = KycTier::Tier0;
        assert!(t.can_deposit());
        assert!(t.can_sell());
        assert!(!t.can_withdraw());
    }

    #[test]
    fn tier0_withdrawal_asks_for_kyc_rather_than_failing_silently() {
        match check_payout(KycTier::Tier0, dec!(1000), dec!(0)) {
            PayoutCheck::KycRequired { next_step } => {
                assert!(next_step.contains("BVN"));
            }
            other => panic!("expected KycRequired, got {other:?}"),
        }
    }

    #[test]
    fn verified_user_within_cap_is_allowed() {
        assert_eq!(
            check_payout(KycTier::Tier1, dec!(20000), dec!(10000)),
            PayoutCheck::Allowed
        );
    }

    #[test]
    fn exactly_at_the_cap_is_allowed() {
        // Off-by-one here would block a user trying to withdraw their last naira.
        assert_eq!(
            check_payout(KycTier::Tier1, dec!(50000), dec!(0)),
            PayoutCheck::Allowed
        );
        assert_eq!(
            check_payout(KycTier::Tier1, dec!(30000), dec!(20000)),
            PayoutCheck::Allowed
        );
    }

    #[test]
    fn one_naira_over_the_cap_is_refused() {
        match check_payout(KycTier::Tier1, dec!(50001), dec!(0)) {
            PayoutCheck::ExceedsDailyCap { remaining, .. } => {
                assert_eq!(remaining, dec!(50000));
            }
            other => panic!("expected ExceedsDailyCap, got {other:?}"),
        }
    }

    #[test]
    fn remaining_never_goes_negative_in_the_message() {
        // If limits were lowered after a payout, used_today can exceed the cap.
        // The user must not be shown "-₦10,000 remaining".
        match check_payout(KycTier::Tier1, dec!(100), dec!(60000)) {
            PayoutCheck::ExceedsDailyCap { remaining, .. } => {
                assert_eq!(remaining, Decimal::ZERO);
            }
            other => panic!("expected ExceedsDailyCap, got {other:?}"),
        }
    }

    #[test]
    fn caps_increase_with_tier() {
        let caps: Vec<_> = [KycTier::Tier1, KycTier::Tier2, KycTier::Tier3]
            .iter()
            .map(|t| t.daily_payout_cap().unwrap())
            .collect();
        assert!(caps.windows(2).all(|w| w[1] > w[0]));
    }

    #[test]
    fn tiers_round_trip_through_the_database_representation() {
        for tier in [
            KycTier::Tier0,
            KycTier::Tier1,
            KycTier::Tier2,
            KycTier::Tier3,
        ] {
            assert_eq!(KycTier::from_i16(tier.as_i16()), Some(tier));
        }
        assert_eq!(KycTier::from_i16(9), None);
    }

    #[test]
    fn top_tier_has_no_further_step() {
        assert_eq!(KycTier::Tier3.next_step(), None);
        assert!(KycTier::Tier0.next_step().is_some());
    }
}
