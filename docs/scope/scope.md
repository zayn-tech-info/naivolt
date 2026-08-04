# Scope: Naivolt

Custodial crypto to naira exchange for people in Nigeria. Users deposit crypto, see spendable naira, and withdraw to bank.

**Build approach:** Journey (finish one coherent user path before the next).
**Workflow:** Alpha (after `/develop`, run `/check verify`). The project's default rigor tier; a feature's own tier tag overrides it.

_You are in charge. Every box below is a **suggestion**, not a gate: run any, skip any, and mark a feature `done` when you decide it is. The workflow records what you actually did (including "skipped"), it never requires a step. The one thing it asks is that a load bearing decision be written down (a spec), not that any check be run._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | Quiet home redesign | Slice 1 | in-progress |
| 2 | Quiet Convert redesign | Slice 1 | in-progress |

## Slice 1: Quiet home

### 1. Quiet home redesign · in-progress
Rebuild the signed in home and tab bar into a quiet ledger look: flat balance surface panel, equal actions, compact pending deposits, flush activity, no promo carousel.
**Done when:** AC-1 through AC-11 in spec 0004 hold on light and dark (greeting and large ₦ first, no mint slab or promo, compact pending rows, flush or quiet empty activity, tab bar selected emphasis, spendable `ngnBalance` only).
- [x] Design it (spec): `/architect quiet home redesign`
- [x] Build it: `/develop quiet home redesign`
   - [x] Home layout cutover: bare balance, actions, pending rows, flush activity, remove promo (AC-1..6, AC-8, AC-11)
   - [x] Home owned components: BalanceHero, DepositProgress, empty and error states (AC-2, AC-5, AC-6, AC-7)
   - [x] Tab bar polish and dead promo or unused balance fill cleanup (AC-4, AC-9, AC-10)
- [ ] Verify it: `/check verify quiet home redesign`
Spec [0004](../specs/0004-quiet-home-redesign.md) · code in `src/app/(tabs)/(main)/index.tsx`, `src/app/(tabs)/(main)/_layout.tsx`, `src/components/home/`

## Slice 1: Quiet Convert

### 2. Quiet Convert redesign · in-progress
Rebuild Convert into a quiet rates and sell calculator: headline ₦/$, refresh countdown, bidirectional calculator, coin list, Convert only, redesigned network sheet, existing address page with optional send hint.
**Done when:** AC-1 through AC-11 in spec 0005 hold (live rate + countdown, bidirectional calculator, USDT default, no Sell/Gift/Withdraw on Convert, network sheet or direct address, optional amount hint, quiet rates states, receive rates only).
- [x] Design it (spec): `/architect quiet convert redesign`
- [x] Build it: `/develop quiet convert redesign`
   - [x] Convert screen: rate hero, countdown, calculator, coin list, Convert CTA (AC-1..4, AC-8, AC-9, AC-11)
   - [x] Quiet NetworkSheet + navigation into deposit address (AC-5, AC-6, AC-10)
   - [x] Optional send amount hint on address page (AC-7, AC-8)
- [ ] Verify it: `/check verify quiet convert redesign`
Spec [0005](../specs/0005-quiet-convert-redesign.md) · code in `src/app/(tabs)/(main)/convert.tsx`, `src/components/exchange/ConvertCalculator.tsx`, `src/components/exchange/NetworkSheet.tsx`, `src/app/deposit/[asset]/[chain].tsx`

## Deferred

Out of scope for the current build pass, kept so the plan stays honest.
- **Home Sell alignment**: share Convert calculator language on Home Sell · from spec 0005
- **Deposit address quiet redesign**: full visual pass on QR / address / notes · from spec 0005
- **Project AI context**: run `/audit` for root `AGENTS.md` · from spec 0004

## Legend

**The decision box.** Every feature carries exactly one, the sub-task whose label ends with `(spec)`. Its wording varies (`Design it (spec)` normally, `Decide the stack (spec)` on Stack & architecture), so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle**: `planned` → `in-progress` → `done`, plus `existing` (pre-workflow) and `dropped` (de-scoped).

- **Next step** = the first unticked box (always a command or a tracked milestone).
- **Atomic build tasks live in the spec's `## Build plan`, not here**: the scope carries only the milestone rollup.
- **Workflow** (header line) is the project default tier. **Alpha** suggests `/check verify` after `/develop`.
