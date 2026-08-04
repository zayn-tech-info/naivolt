# 0001. Light signup experience

**Date**: 2026-08-02
**Status**: In Progress

## Summary

The signup journey will use a focused light theme and a moving crypto logo hero inspired by the supplied reference. Choosing phone replaces that provider selection screen with a focused phone entry state. Existing passwordless authentication stays intact.

## Context

The current signup screen is functional but visually sparse compared with the desired first impression. It presents authentication controls before establishing a strong product identity. The supplied reference gives the intended composition, but its dark palette and generic typography do not match Naivolt.

The existing screen already owns working Google, Apple, and phone authentication. Its service calls, error behavior, and navigation are production constraints. The design must improve presentation without splitting signin from signup or changing any authentication contract.

Naivolt already has a complete light palette, Instrument Sans typography, Reanimated, and clean local crypto assets. The implementation should reuse those parts and avoid a new package or external image dependency.

## Requirements

**User stories**:

1. As a new or returning user, I want a polished signup entry that clearly feels like Naivolt so that I can choose an authentication method with confidence.
2. As a phone user, I want a focused phone entry screen after choosing phone so that I do not see provider information I already acted on.
3. As a user who prefers less motion, I want the crypto hero to remain usable without continuous animation.

**Acceptance criteria**:

1. **AC-1**: The signup screen renders in Naivolt light colors with Instrument Sans and the existing type scale, regardless of the saved application theme.
2. **AC-2**: The hero shows three clipped rows made from existing local crypto assets. The first and third rows flow left, the middle row flows right, and all rows loop without a visible blank gap.
3. **AC-3**: Row motion uses calm linear durations of 28, 34, and 30 seconds. Motion pauses during phone entry and is disabled when the device requests reduced motion.
4. **AC-4**: Selecting Continue with phone replaces the provider selection content with a back action, the existing phone field, validation feedback when needed, and the Continue action. The phone entry state does not render the crypto hero, welcome copy, social provider actions, divider, or legal copy.
5. **AC-5**: Google, supported iOS Apple, and phone authentication retain their existing loading, cancellation, validation, error, session, and navigation behavior.
6. **AC-6**: Signup, phone verification, and first time PIN setup stay light through the full signup journey. Entering the main application restores the saved application theme.
7. **AC-7**: The screen remains usable on small and large phones, with keyboard avoidance, safe area handling, readable contrast, logical focus order, screen reader labels, and touch targets of at least 44 points.
8. **AC-8**: No backend contract, authentication endpoint, route destination, stored theme preference, database model, or external asset dependency changes.

## Options considered

### Option 1: Fix the signup journey in place

Keep the working authentication flow and replace only its presentation. Add a scoped light theme boundary and a reusable local asset hero.

**Pros**:

1. Preserves proven authentication behavior and limits regression risk.
2. Reuses the current design system, dependencies, and assets.

**Cons**:

1. The new visual treatment is intentionally limited to the signup journey.
2. The moving hero adds animation code that must handle accessibility and lifecycle cleanup.

### Option 2: Build a parallel auth experience and migrate later

Create new routes beside the current auth flow, test them independently, then switch entry navigation.

**Pros**:

1. Provides a simple route level rollback.
2. Keeps the current screen untouched during development.

**Cons**:

1. Duplicates working auth state and navigation code for a visual enhancement.
2. Creates extra maintenance and testing work without reducing the main risks.

### Option 3: Replace the auth flow directly

Recreate the reference with separate signup and signin actions and new authentication screens.

**Pros**:

1. Can copy the reference composition more literally.

**Cons**:

1. Conflicts with Naivolt passwordless authentication, where signup and signin are the same action.
2. Introduces unnecessary backend and navigation changes.

## Decision

**Chosen option**: Option 1: Fix the signup journey in place

Improve the existing auth screen with a scoped light theme, a coordinated local asset marquee, and a focused phone entry state while preserving all auth behavior.

## Rationale

The gap is visual, not architectural. Replacing or duplicating authentication would expand risk without improving the requested experience. A focused change uses everything the project already does well and makes rollback a normal code revert.

The local crypto assets remove network, licensing, caching, and broken link concerns. Reanimated is already part of the application, so the hero needs no new runtime dependency. Once phone is chosen, replacing provider selection avoids repeating information and keeps attention on the required input. The scoped theme boundary is preferable to changing the saved global mode because the user choice must remain intact after signup.

## Feature design

**Data model sketch**:

No data model changes.

**State transitions**:

1. Default signup state to focused phone entry when Continue with phone is pressed.
2. Focused phone entry to default signup state when the back action is pressed.
3. Phone entry to phone loading, then OTP verification on success or phone entry with an error on failure.
4. Social idle to social loading, then PIN setup for a new account or the main application for a returning account. Cancellation returns to social idle without an error.

**API surface**:

| Surface | Inputs | Outputs | Auth | Key errors |
|---|---|---|---|---|
| Existing Google OIDC flow | Provider token | Session and new account flag | Public | Cancellation, provider failure, server rejection |
| Existing Apple OIDC flow | Provider token and optional first authorization name | Session and new account flag | Public | Cancellation, provider failure, server rejection |
| Existing OTP request | Normalized phone number | Verification route parameters | Public | Invalid phone, offline state, server rejection |

**Value sourcing**:

| Action | Value produced or displayed | Source |
|---|---|---|
| Render hero | Logo images | Static imports from `assets/images/coins/` |
| Animate hero | Direction and duration | Row configuration fixed in this spec |
| Render signup copy | Heading and body | Copy fixed in this spec |
| Render colors | Light palette | Scoped theme override using `lightColors` |
| Render typography | Font family, size, line height, and weight | Existing Naivolt type tokens |
| Show social actions | Provider availability | Existing platform and provider availability checks |
| Reveal phone entry | Back action, existing phone field, validation feedback, and Continue action | Local phone entry state and existing auth components |
| Enable phone submission | Validity | Existing `normalizePhone` result |
| Continue phone signup | Verification phone parameter | Existing `requestOtp` response |
| Continue social signup | Session destination | Existing `isNewAccount` response |
| Render first time PIN theme | Signup journey context | `signup=1` route parameter set only by new account auth paths |
| Restore application theme | Theme mode | Existing persisted app store mode after leaving the scoped boundary |

**Key invariants**:

1. The global theme store is never mutated by the scoped light boundary.
2. Authentication service calls and route destinations remain unchanged.
3. The PIN screen uses the light override only when its `signup=1` route parameter is present.
4. The phone entry state does not render the logo marquee or provider selection content.
5. Every animated track contains a duplicated sequence so the loop has no empty interval.
6. The accent color remains reserved for actions and is not used to decorate the heading.

**Security model**:

Authentication security remains unchanged. The screen continues to send provider tokens and normalized phone input through the existing auth services. No credential, token, or personal data is added to animation or theme state.

**Critical test scenarios**:

1. Happy path: open signup from a saved dark theme, use Google or phone, complete new account PIN setup, and enter the main application with the saved dark theme restored, verifies **AC-1**, **AC-5**, and **AC-6**.
2. Motion and focus: observe all three tracks through a full loop, enable reduced motion, then open phone entry and confirm only the back action, phone field, relevant validation feedback, and Continue action remain, verifies **AC-2**, **AC-3**, and **AC-4**.
3. Failure case: submit an invalid phone, simulate OTP failure, cancel a social provider sheet, and retry, verifies **AC-5**.
4. Layout: inspect small and large iOS and Android devices with the keyboard open and a screen reader enabled, verifies **AC-7**.
5. Compatibility: compare auth service calls, route destinations, and stored theme values before and after the change, verifies **AC-8**.

## Build plan

1. [x] Add a scoped theme override provider and a light signup journey wrapper without mutating the saved theme, satisfies **AC-1**, **AC-6**, and **AC-8**.
2. [x] Build the reusable three row crypto logo marquee with local assets, seamless tracks, pause control, compact layout, and reduced motion handling, satisfies **AC-2**, **AC-3**, and **AC-7**.
3. [x] Recompose the signup screen and add a focused phone entry state while retaining every existing auth handler and state, satisfies **AC-1**, **AC-4**, **AC-5**, and **AC-7**.
4. [ ] Apply the light boundary to verification and first time PIN setup, then run static and device checks across the full journey, satisfies **AC-5**, **AC-6**, **AC-7**, and **AC-8**. The code and static checks are complete. Device visual checks remain pending.

## Consequences

**Positive**:

1. Signup gains a distinctive visual identity without auth or backend risk.
2. Local assets and existing libraries keep the experience reliable offline and simple to maintain.
3. The theme boundary becomes reusable for future screens that need a deliberate theme.

**Negative and tradeoffs**:

1. The signup journey can differ from the saved theme until the user reaches the main application.
2. Continuous animation consumes some rendering work, even though the motion is slow and pauses for reduced motion and phone entry.
3. The provider choice and phone entry states use separate compositions inside one route.

**Neutral**:

1. The onboarding carousel remains unchanged.
2. No migration, feature flag, new environment value, or external resource is required.
