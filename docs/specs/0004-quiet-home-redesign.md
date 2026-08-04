# 0004. Quiet home redesign

**Date**: 2026-08-04
**Status**: In Progress

## Summary

Home and the bottom tab bar shift to a quiet ledger look. The screen answers how much naira is available, what to do next, and what just happened, without promo chrome or a filled mint balance slab. Available naira sits on its own flat surface panel (the usual fintech balance block). Pending deposits stay visible as compact rows when the chain is still confirming. Build work stays on the Expo home journey and tab bar only; money APIs and other screens stay as they are.

## Context

The signed in home is opened many times a day. The current layout stacks a gradient mint balance card with a glow, actions nested inside that card, a placeholder promo carousel, a titled In progress section, and a wrapped activity card. That reads busy and template like. Users who just sent crypto need a calm confirmation signal, not theater. Users who are checking available naira need one large number and clear next steps.

Spec 0003 already set foundations (tokens, type, components) and an earlier home composition. That composition still mixes marketing surfaces into the daily screen and keeps a loud balance treatment. Leaving it as is trains the eye to ignore noise and weakens trust in the one number that matters (spendable naira from the ledger).

This decision does not change custody, ledger math, or the exchange API. It changes how home and the tab bar present existing data so the product feels calm and professional.

## Requirements

**User stories**:
- As a signed in user, I want to see my available naira first so I know what I can withdraw.
- As a signed in user, I want equal Sell, Gift cards, and Withdraw actions so I can start the right flow in one tap.
- As a signed in user with a deposit confirming, I want a compact status row so I know the chain is still working and my money is not lost.
- As a signed in user, I want recent activity without heavy chrome so I can scan history quickly.
- As a signed in user, I want a calm tab bar with a clear selected tab so navigation stays obvious.

**Acceptance criteria** (the contract, each criterion is IDed and independently checkable):
- **AC-1**: The first viewport reads as one quiet composition: greeting, large available naira, then actions.
- **AC-2**: The balance sits inside its own flat surface panel (`BalanceCard`) with no gradient fill, glow orb, or filled mint card. Actions stay outside that panel.
- **AC-3**: Actions are three equal icon wells with short labels; Sell opens `/deposit`, Gift cards opens `/gift-cards`, Withdraw opens `/withdraw`.
- **AC-4**: The promo carousel is absent from home; after cutover `PromoCarousel` is removed or has no remaining consumers.
- **AC-5**: Pending deposits render as compact rows only when `usePendingDeposits` returns items; there is no titled In progress section banner.
- **AC-6**: Recent activity is a flush list under a short title with See all, or a quiet empty line with one text link when there are no items; See all opens the Activity tab.
- **AC-7**: While portfolio is loading, the amount shows a skeleton and actions stay tappable; on portfolio fetch error a short inline retry appears under the balance.
- **AC-8**: Pull to refresh refetches portfolio, activity, and pending deposits.
- **AC-9**: The tab bar keeps Home, Convert, Activity, and Profile; selected state uses clearer emerald with slightly larger icon and label emphasis; unselected stays calm; safe area behavior is unchanged.
- **AC-10**: Light theme, dark theme, reduced motion, and 48 point touch targets still hold through existing design tokens and shared components.
- **AC-11**: The headline amount is spendable `portfolio.ngnBalance` only; home never shows margin, mid rate, or a crypto portfolio total.

## Options considered

### Option 1: Quiet ledger home

Bare canvas balance, separate equal actions, no promo carousel, compact pending rows, flush activity, quiet tab bar with stronger selected emphasis.

**Pros**:
- Matches how strong retail crypto apps answer how much, what next, what happened
- Removes the surfaces that feel most artificial on a daily screen
- Fits 0003 tokens without inventing a second system

**Cons**:
- Less color drama on first open
- First time users get less promotional guidance on home

### Option 2: Soft tinted balance band

Same composition as Option 1, but keep a quiet accent wash behind the balance.

**Pros**:
- Keeps a brand cue around the money number
- Slightly softer jump from the old mint card

**Cons**:
- Still risks reading as decorative rather than ledger quiet
- Easy to drift back toward a filled card

### Option 3: Dense pro exchange home

Darker, tighter trading style with more metrics on home.

**Pros**:
- Feels “pro” to crypto native users

**Cons**:
- Conflicts with Naivolt’s one spendable naira story
- Adds noise this product does not need on home

## Decision

**Chosen option**: Option 1: Quiet ledger home, with the balance on a flat neutral surface panel (common fintech balance block) instead of bare canvas.

Home and the bottom tab bar use the quiet ledger direction. Spec [0003 home navigation](0003-mobile-design-system/0003-home-navigation.md) is superseded for home composition; foundations in 0003 stay in force. Tab bar polish in this spec updates the bar treatment while keeping the same four tabs. The balance figure lives in `BalanceCard` (flat `Surface`, no mint gradient).

**Implementation skills**: none recorded in project context (`AGENTS.md` is missing). Workflow skill `/develop` builds from this spec.

## Rationale

Daily money screens fail when marketing and status theater compete with the balance. Research and current wallet patterns favor progressive disclosure: large balance, thumb friendly actions, hide empty or promotional blocks. Option 1 removes the loudest offenders (gradient slab, glow, promo carousel, In progress banner) while keeping the one anxious signal that earns its place (confirming deposits). Option 2 keeps unnecessary color surface. Option 3 fights the product rule that home shows spendable naira, not a trading desk.

Scope stays on home owned components plus tab bar polish so Convert and money flows are not destabilized mid migration. Shared `QuickAction` stays usable in neutral tone for Convert’s existing action row.

## Feature design

**Data model sketch**:
No new entities. Home continues to read:
- `Portfolio.ngnBalance` (string decimal) via `usePortfolio`
- `Deposit[]` via `usePendingDeposits` (`confirmations`, `minConfirmations`, `asset`, `amount`, `status`)
- `ActivityItem[]` via `useActivity` (preview slice on home)
- `balanceHidden` via `useAppStore`

**State transitions**:
Pending deposit visibility: absent when the pending list is empty → compact rows while `detected` or `confirming` → rows disappear when credited (list empty). No new client state machine beyond existing query data.

**API surface**:
No new endpoints. Existing `ExchangeService` methods only.

| Action | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| Load portfolio | existing `getPortfolio` via hook | session | `ngnBalance` | bearer | network / 401 |
| Load pending deposits | existing `getPendingDeposits` | session | `Deposit[]` | bearer | network / 401 |
| Load activity | existing `getActivity` (or equivalent hook) | session | items | bearer | network / 401 |

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Show available naira | Headline amount | `usePortfolio` → `portfolio.ngnBalance` |
| Hide / show balance | Masked vs visible | `useAppStore.balanceHidden` / `toggleBalanceHidden` |
| Greeting title | Good morning / afternoon / evening | Device local hour (existing `greeting()` helper) |
| Header history action | Opens Activity | Expo Router `/(tabs)/(main)/history` |
| Sell / Gift cards / Withdraw | Navigation targets | `/deposit`, `/gift-cards`, `/withdraw` |
| Pending row copy | Remaining confirmations text | `minConfirmations - confirmations` from each `Deposit` |
| Pending meter | Fill ratio | `confirmations / minConfirmations` |
| Pending amount | Right side amount + asset | `Deposit.amount`, `Deposit.asset` |
| Recent rows | Up to four activity rows | `useActivity` items slice |
| Empty activity link | Text action into a money flow | `/gift-cards` (matches prior empty CTA intent) |
| Tab selection | Active tab chrome | Expo Router `Tabs` focus in `(main)/_layout.tsx` |
| Portfolio error retry | Refetch | `portfolio.refetch()` |

**Key invariants**:
- Home never renders mid rate, spread, or non spendable totals as the headline.
- Pending UI appears only when the pending deposits query returns a non empty list.
- Actions remain tappable while the balance skeleton is showing.
- Tab set remains exactly four: Home, Convert, Activity, Profile.

**Security model**:
Home remains behind the existing signed in session. No new PII on this screen. Balance hide is a local preference for shoulder surfing, not an access control.

**Configuration required**:
None. No new env vars.

**Critical test scenarios**:
- Happy path: signed in user with balance, no pending deposits, some activity sees greeting, bare balance, three actions, flush activity; verifies **AC-1**, **AC-2**, **AC-3**, **AC-6**, **AC-11**
- Pending deposit: mock or fixture pending list shows compact rows without In progress title; verifies **AC-5**
- Empty activity: quiet empty line and text link, no large EmptyState card; verifies **AC-6**
- Portfolio loading and error: skeleton then inline retry; actions still pressable; verifies **AC-7**
- Pull to refresh updates the three queries; verifies **AC-8**
- Promo carousel not on home after cutover; verifies **AC-4**
- Tab bar selected vs unselected emphasis across four tabs; verifies **AC-9**
- Light / dark and reduced motion still coherent; verifies **AC-10**

## Build plan

Build approach assumption: **Journey** (complete home plus tab bar as one coherent path). No schema migration.

1. [x] Restructure `src/app/(tabs)/(main)/index.tsx`: remove gradient shell and `PromoCarousel`; compose greeting, bare `BalanceHero`, neutral `ActionBar`, conditional compact pending rows, flush recent activity (or quiet empty line); keep pull to refresh. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-6**, **AC-8**, **AC-11**
2. [x] Redesign `src/components/home/BalanceHero.tsx` for canvas (default) tone on home; stop using contrast mint path on home. Satisfies **AC-2**, **AC-7**, **AC-11**
3. [x] Redesign `src/components/home/DepositProgress.tsx` as a compact status row (glyph, remaining copy, amount, thin meter); home stacks rows with no section banner. Satisfies **AC-5**
4. [x] Keep equal icon wells via `ActionBar` / `QuickAction`; home uses neutral tone so Convert’s existing `ActionBar` stays coherent. Satisfies **AC-3**, **AC-10**
5. [x] Implement quiet empty activity on home (short copy + one text link). Satisfies **AC-6**
6. [x] Add portfolio inline retry under the balance on fetch error; keep amount skeleton while loading. Satisfies **AC-7**
7. [x] Polish tab bar in `src/app/(tabs)/(main)/_layout.tsx`: quieter chrome, clearer selected emerald, slightly larger selected icon and label emphasis; same four tabs. Satisfies **AC-9**, **AC-10**
8. [x] Remove dead `PromoCarousel` path when unused; note or clean unused balance fill tokens if nothing else references them. Satisfies **AC-4**
9. [ ] Manually verify AC-1 through AC-11 on light and dark (later `/check verify` when enrolled). Satisfies **AC-1**–**AC-11**

## Consequences

**Positive**:
- Home matches the product story: one spendable naira figure and clear next steps
- Confirming deposits stay honest without section theater
- Tab bar selection is easier to read without new navigation complexity

**Negative / tradeoffs**:
- Less promotional surface for first time education on home
- Convert is not redesigned in this pass, so visual polish is uneven until later journeys move
- Slightly larger selected tab icon must stay within safe area and avoid clipping labels

**Neutral**:
- Balance fill color tokens may become unused until cleaned
- [0003 home navigation](0003-mobile-design-system/0003-home-navigation.md) no longer governs home composition

## Follow-up

- [x] Enroll this feature in `docs/scope/` when ready so `/develop` and `/check` have a scope row
- [ ] Run `/audit` so root `AGENTS.md` exists for later skills
- [ ] Revisit Convert screen quiet pass after home ships
## Migration plan

**Strategy**: big bang on home and tab bar only (single focused UI change; no live data transform)

**Phases**:
1. Ship the new home composition and tab bar polish against existing mocks / API hooks
2. Delete unused promo component and unused balance fill tokens if safe

**Rollback**: Revert the home and tab layout commit; no data migration to undo

**Risks**:
- Convert still shows the older action row context if shared tone drifts
- Selected tab emphasis could feel uneven on very small devices if label size grows too much
