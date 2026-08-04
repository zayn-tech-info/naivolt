# 0002. Home balance and action card

**Status**: Superseded by [0003](0003-mobile-design-system/index.md)
**Date**: 2026-08-03
**Authorized by**: engineer, during /develop

## Owed decision

How the requested Buy action behaves while the backend has no crypto purchase flow, and how the reference card maps to Naivolt data and routes.

## Assumption built on

The home screen shows one accent balance card using the real spendable naira balance. It does not invent a user name. Buy is visible but disabled with a Coming soon status. Sell opens the existing Convert screen. Deposit opens Deposit. Withdraw opens Withdraw. Existing loading, balance privacy, refresh, activity, and payout behavior remain unchanged.

## Code area

`src/app/(tabs)/(main)/index.tsx`

`src/components/home/BalanceHero.tsx`

`src/components/home/ActionBar.tsx`

## Requirements

1. The balance and four actions form one cohesive card inspired by the supplied reference and styled with existing Naivolt tokens.
2. The displayed value comes from `portfolio.ngnBalance` and remains explicitly labelled as available naira balance.
3. No user name, username, percentage change, or invented financial value appears.
4. Buy is disabled and visibly marked Coming soon. Sell, Deposit, and Withdraw use their existing real routes.
5. Loading, hidden balance, screen reader labels, touch targets, compact phone widths, and dark mode remain supported.

## Ratify

This decision was recorded by /develop, not deliberated. Run `/architect home balance and action card` to deliberate and ratify it. The feature cannot be marked `done` until then.
