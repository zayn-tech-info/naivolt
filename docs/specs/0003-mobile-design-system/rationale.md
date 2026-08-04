# Rationale for the Naivolt mobile design system

## Context

The mobile app already has useful semantic tokens and shared components, but two visual systems still coexist. Product screens mix new theme primitives with legacy colors, local type sizes, repeated navigation geometry, and isolated spacing decisions. This creates visible alignment and hierarchy problems even when each component works by itself.

The product handles money, identity, and transfers. Users need calm hierarchy, exact figures, clear actions, and predictable states. The system must work on compact Android phones, support larger device text, preserve light and dark themes, and keep motion accessible.

The app already uses React Native, Expo, Instrument Sans, Geist Mono, Ionicons, Reanimated, and haptics. Reusing these tools avoids a second component stack and keeps the migration understandable.

## Options considered

### Option 1: Document the direction only

Keep the current components and rely on review to follow written guidance.

**Pros**:

* Small immediate change.
* No migration cost.

**Cons**:

* Local styles continue to enter the app.
* Reviewers must find every visual violation by hand.

### Option 2: Replace every screen in one change

Create the final system and migrate the whole app at once.

**Pros**:

* The app reaches one visual state quickly if the change succeeds.
* Legacy code can be removed immediately.

**Cons**:

* The review and regression surface is too large.
* Broken journeys are harder to isolate and reverse.

### Option 3: Enforce the standard and migrate by journey

Make the new system mandatory for new code, then move complete user journeys in a fixed order.

**Pros**:

* Each completed journey remains coherent.
* Verification and rollback stay focused.
* Legacy code disappears as its last consumer moves.

**Cons**:

* Old and new internals coexist during migration.
* Temporary audit exceptions need active ownership.

## Rationale

Option 3 gives the strongest enforcement without the risk of a full rewrite. Journey migration fits the way users experience the product and provides clear verification boundaries. The existing stack is capable of the final system, so a new styling library would add cost without solving the main problem, which is consistency and ownership.

Neutral surfaces and restrained emerald action color reduce competing emphasis. Unified sans typography makes balances feel like part of the product instead of terminal output. Geist Mono remains useful where character by character verification is the real job.

## Current state inventory

* The semantic theme lives in `src/design` and `src/constants/colors.ts`.
* The active component library lives in `src/components/ui`.
* The legacy theme in `src/constants/theme.ts` still serves old primitives.
* Product files still contain direct type, spacing, curve, color, and icon size values.
* Reduced motion support exists in some components but is not one shared contract.
