# 0005. Quiet Convert redesign

**Date**: 2026-08-04
**Status**: In Progress

## Summary

The Convert tab becomes a quiet rates and sell calculator. Users see the live naira per dollar rate with a refresh countdown, type crypto or naira in a bidirectional calculator, pick a coin from the board, then tap Convert. Multi chain assets open a redesigned network sheet; then the existing deposit address page shows QR, address, notes, and an optional send amount hint. Sell, Gift cards, and Withdraw leave this tab. Home Sell and a full address visual redesign stay for a later pass.

## Context

Convert today is a rates board plus a home style action bar. It does not start a sell. Users who open Convert expecting to turn crypto into naira hit a dead end, while Home Sell already opens the deposit address journey. The board also carries marketing noise and competing CTAs that fight a clean calculator pattern used by retail convert screens elsewhere.

The product still sells by permanent deposit address, not by an instant wallet swap. So Convert must feel like a popular converter calculator, then land on network choice and the address screen, without inventing a locked quote execute path in this pass.

Foundations stay in spec 0003. Quiet home stays in spec 0004. This decision only owns the Convert tab, its network sheet, and a light address hint.

## Requirements

**User stories**:
- As a signed in user, I want live rates and a refresh countdown so I trust the figure on screen.
- As a signed in user, I want to enter crypto or naira and see the other side update live so I can plan a sell.
- As a signed in user, I want to pick a coin and tap Convert so I can get a deposit address on the right network.
- As a signed in user sending a known amount, I want a send hint on the address page so I know how much to transfer.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: Convert shows the headline live ₦ per $1 rate plus a visible refresh countdown tied to the live rates refresh window.
- **AC-2**: The calculator is bidirectional: editing the crypto amount or the ₦ amount updates the other live from the selected asset’s board rate.
- **AC-3**: The available coins list comes from the rates board; tapping a row selects that asset in the calculator; default selection is USDT when present on the board, otherwise the first board asset.
- **AC-4**: Convert does not show Sell, Gift cards, or Withdraw actions.
- **AC-5**: Tapping Convert for a multi chain asset opens a redesigned quiet network sheet (no preselected network; one tap commits), then navigates to `/deposit/[asset]/[chain]`.
- **AC-6**: Tapping Convert for a single chain asset skips the network sheet and opens the address route for that chain.
- **AC-7**: When a crypto amount is present, the address page shows an optional send hint (for example “Send about 50 USDT”); the page works without the hint when amount is absent.
- **AC-8**: Convert remains enabled when both calculator fields are empty; the address page then omits the send hint.
- **AC-9**: Loading, empty, and error rates states are quiet and usable (skeleton, empty copy, retry or pull to refresh).
- **AC-10**: Light theme, dark theme, reduced motion, and 48 point touch targets still hold through existing design tokens and shared components.
- **AC-11**: Every rate shown is the receive rate only; mid rate and spread are never displayed.

## Options considered

### Option 1: Quiet convert calculator into deposit

Rates hero with refresh countdown, bidirectional calculator, coin list, Convert CTA, redesigned network sheet, existing address page with optional amount hint.

**Pros**:
- Matches how users expect a convert calculator to work
- Reuses custody deposit addresses already in the product
- Removes dead CTAs from Convert

**Cons**:
- Overlaps Home Sell until that flow is redesigned
- No locked quote guarantee on Convert tap (board rate is advisory until funds confirm)

### Option 2: Instant locked quote convert

Binance style preview with a short locked quote, then credit naira from wallet balance.

**Pros**:
- Familiar exchange convert pattern

**Cons**:
- Needs balance sell and quote execute wiring this product does not use for Convert yet
- Conflicts with deposit based sell

### Option 3: Rates board only, no calculator

Keep Convert as a price board; sell only from Home.

**Pros**:
- Smaller change

**Cons**:
- Leaves Convert feeling useless for the primary job

## Decision

**Chosen option**: Option 1: Quiet convert calculator into deposit

Convert is a quiet rates and calculator tab that starts the existing deposit address journey. Network sheet is redesigned for clarity. Address screen gets an optional send amount hint and light copy polish only.

**Implementation skills**: none recorded in project context (`AGENTS.md` is missing). Workflow skill `/develop` builds from this spec.

## Rationale

Users open Convert to price a sell and start sending crypto. A bidirectional calculator plus coin list is the standard retail pattern. Landing on the permanent deposit address keeps custody invariants intact. A rates refresh countdown is enough for this pass; locked quotes belong to a later sell or quote product decision. Redesigning the network sheet here removes a known sloppy surface on the critical wrong network path, while deferring a full address visual redesign keeps the journey shippable.

## Feature design

**Data model sketch**:
No new entities. Convert reads:
- `RateBoard` via `useRates` (`ngnPerUsd`, `assets[]` with `asset`, `usdPrice`, `rate`, `changePct24h`)
- Chain options via `CHAINS_FOR_ASSET` / deposit constants
- Deposit address via existing `useDepositAddress` on the address route
- Optional `amount` (crypto string) passed as a navigation param into the address route

**State transitions**:
Convert idle → asset selected (default USDT) → amounts edited (optional) → Convert tapped → (multi chain: network sheet open → chain chosen) → address route. Sheet dismiss without selection returns to Convert.

**API surface**:
No new endpoints.

| Action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| Load rates | existing `getRates` via `useRates` | session | `ngnPerUsd`, assets | bearer | network |
| Load deposit address | existing `getDepositAddress` | asset, chain | address | bearer | network / paused |

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Headline ₦ per $1 | Hero rate | `useRates` → `ngnPerUsd` |
| Refresh countdown | Seconds until next refresh | Client timer aligned to `useRates` `refetchInterval` (30s) and last successful fetch time |
| Coin list rows | Asset, USD, ₦ rate | `useRates` → `assets[]` |
| Selected asset | Calculator coin | Default USDT if on board, else first asset; user tap overrides |
| Crypto → ₦ | Naira field | `cryptoAmount * Number(selected.rate)` |
| ₦ → crypto | Crypto field | `ngnAmount / Number(selected.rate)` when rate is positive |
| Network options | Sheet rows | `CHAINS_FOR_ASSET[asset]` / existing chain meta |
| Address QR and copy field | Deposit address | `useDepositAddress(asset, chain)` |
| Send hint | “Send about X ASSET” | Nav param `amount` from Convert when non empty |

**Key invariants**:
- Margin and mid rate never appear on Convert.
- No network is preselected in the sheet.
- Convert never mounts Sell, Gift cards, or Withdraw actions.
- Empty amount does not block Convert.

**Security model**:
Signed in session only. Wrong network risk is mitigated by explicit network choice and existing address page warning. No new PII.

**Configuration required**:
None.

**Critical test scenarios**:
- Happy path USDT multi chain: calculator → Convert → network sheet → address with hint → **AC-2**, **AC-5**, **AC-7**
- Single chain asset: Convert → address, no sheet → **AC-6**
- Empty amount Convert → address without hint → **AC-8**
- Bidirectional edit updates both fields from board rate → **AC-2**
- Default USDT when present → **AC-3**
- No Sell / Gift cards / Withdraw on Convert → **AC-4**
- Rates loading and error → **AC-9**
- Receive rates only → **AC-11**

## Build plan

Build approach: **Journey** (scope header).

1. Rebuild `src/app/(tabs)/(main)/convert.tsx`: remove `ActionBar`; compose rate hero with countdown, calculator, coin list, Convert CTA; wire navigation. Satisfies **AC-1**, **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-8**, **AC-9**, **AC-11**
2. Add Convert calculator UI (bidirectional crypto and ₦ fields, selected asset). Satisfies **AC-2**, **AC-3**, **AC-8**
3. Redesign `src/components/exchange/NetworkSheet.tsx` to a quiet professional sheet; open from Convert for multi chain assets. Satisfies **AC-5**, **AC-10**
4. Pass optional amount param into `/deposit/[asset]/[chain]`; show send hint and light copy polish on the address screen. Satisfies **AC-7**, **AC-8**
5. Rates loading, empty, and error states plus pull to refresh. Satisfies **AC-9**
6. Manually verify AC-1 through AC-11 (later `/check verify`). Satisfies **AC-1**–**AC-11**

## Consequences

**Positive**:
- Convert becomes a real sell entry with a familiar calculator pattern
- Wrong network risk stays behind an explicit quiet sheet
- Tab no longer advertises unrelated money actions

**Negative / tradeoffs**:
- Board rate is not a locked quote; credited naira still follows deposit confirmation
- Home Sell and Convert both reach deposit until Home Sell is redesigned
- Address visual redesign is deferred, so Convert lands on a screen that still looks older

**Neutral**:
- `QuoteTimer` remains unused for locked quotes until a later sell quote decision
- Spec 0004 deferred “Convert quiet pass” is fulfilled by this feature once enrolled

## Follow-up

- [x] Enroll this feature in `docs/scope/` when the spec is accepted
- [ ] Redesign Home Sell to share this calculator language
- [ ] Full quiet redesign of the deposit address screen
- [ ] Decide locked quote sell later if product wants guaranteed preview rates

## Migration plan

**Strategy**: big bang on Convert tab and NetworkSheet; additive amount param on address route

**Phases**:
1. Ship Convert calculator and redesigned sheet against existing rates and deposit hooks
2. Add optional amount hint on address; keep old callers working without the param

**Rollback**: Revert Convert and NetworkSheet commits; remove amount hint branch on address

**Risks**:
- Dual entry (Home Sell vs Convert) may confuse until Home Sell is aligned
- Bidirectional rounding must stay stable enough that flipping fields does not thrash values
