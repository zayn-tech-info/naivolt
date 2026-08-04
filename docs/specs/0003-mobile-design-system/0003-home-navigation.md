# Home and navigation

**Status**: Superseded by [0004](../0004-quiet-home-redesign.md) for home composition and tab bar visual polish.

Home layout, balance treatment, actions, pending deposits, recent activity, and tab bar emphasis are defined in [0004 Quiet home redesign](../0004-quiet-home-redesign.md). Do not build home from this file.

What still stands from this document until a later navigation only pass:

* Top level tab screens use `TopLevelHeader`.
* Focused journeys use `FlowHeader` with a back action, title, and optional trailing action.
* Foundations remain under the parent [0003 mobile design system](index.md).

---

## Summary (historical)

Home is the first migrated journey because it defines the daily product experience. The balance, actions, activity, headers, and bottom navigation use the new neutral hierarchy.

## Home composition (historical)

1. A top level header shows the time greeting and account action.
2. A neutral balance card shows available naira, privacy control, and withdrawal readiness.
3. A separate quick action row shows Sell, Deposit, and Withdraw.
4. Pending deposits appear only when present.
5. Recent activity follows with a clear path to the complete feed.

Buy does not appear because the product does not support crypto purchases. The three supported quick actions use equal 48 point circles, shared icon size, centered labels, and equal spacing.

## Navigation (historical)

The signed in app uses a fixed neutral bottom bar. Every tab shows an icon and short label. Emerald marks the selected tab. The bar respects safe area and larger text without covering content.

Top level tab screens use `TopLevelHeader`. Focused journeys use `FlowHeader` with a back action, title, and optional trailing action.

## Value sources (historical)

* Available balance comes from `portfolio.ngnBalance`.
* Greeting comes from the device local hour.
* Pending deposits come from the existing pending deposit query.
* Recent activity comes from the existing activity query.
* Sell routes to Convert. Deposit routes to Deposit. Withdraw routes to Withdraw.
