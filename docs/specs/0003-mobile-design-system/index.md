# 0003. Naivolt mobile design system

**Date**: 2026-08-03
**Status**: Accepted

## Summary

Naivolt uses one modern retail fintech system across the mobile app. Neutral surfaces carry content, emerald marks actions and selection, and one sans family creates a calm reading rhythm. Existing journeys move to the system one complete journey at a time.

## Structure

* [Foundations](0001-foundations.md) defines type, color, spacing, geometry, motion, and accessibility.
* [Components](0002-components.md) defines the canonical mobile component library and its enforcement.
* [Home and navigation](0003-home-navigation.md) defined the first migrated journey. Home composition and tab bar polish are superseded by [0004 Quiet home redesign](../0004-quiet-home-redesign.md). Header patterns (`TopLevelHeader` / `FlowHeader`) still stand here.
* [Migration](0004-migration.md) defines the journey order and removal rules.
* [Verification](verify.md) defines the evidence required before each journey is complete.

## Decision

**Chosen option**: Define and enforce one system, then migrate one complete journey at a time.

New mobile code must use the shared design tokens and canonical components. Existing code moves in journey order so each user path remains coherent while the migration is in progress.

## Standard definition

**Canonical pattern**:

```tsx
import { Button, Screen, Surface, Text } from '@/components/ui';
import { useTheme } from '@/design';

export function ExampleScreen() {
  const { space } = useTheme();

  return (
    <Screen>
      <Text variant="title">Screen title</Text>
      <Surface level={1} style={{ marginTop: space.comfy }}>
        <Text variant="body">Useful content</Text>
      </Surface>
      <Button title="Continue" onPress={() => {}} fullWidth />
    </Screen>
  );
}
```

**Replaces**:

* Direct React Native text in product screens.
* Raw palette imports, raw color values, and the legacy theme module.
* Local font sizes, unsupported curves, and repeated icon button geometry.
* Journey specific headers and navigation controls that duplicate canonical components.

**Enforcement**:

ESLint blocks forbidden imports. A design audit script reports raw visual values and legacy components. TypeScript keeps theme and component variants inside their declared contracts.

**Rollout**:

New code complies immediately. Existing code moves by complete journey, beginning with home and navigation.

**Exceptions**:

Asset brand colors may remain inside `AssetGlyph`. QR codes may use black on white where scanners require it. Error boundaries and the native splash may use a minimal fallback palette because the design provider might not be available.

## Consequences

**Positive**:

* Every screen shares one visual hierarchy and interaction language.
* Light theme, dark theme, larger text, and reduced motion become system behavior instead of screen work.
* New journeys have fewer local design choices and become easier to review.

**Negative and tradeoffs**:

* The migration touches many mobile files and must remain incremental.
* Strict enforcement will expose existing debt until each journey moves.
* Expressive motion needs a static reduced motion alternative for every branded sequence.

**Neutral**:

* Backend contracts and financial calculations do not change.
* The admin workspace is outside this decision and will move in a separate repository task.

## Follow-up

* Remove the admin workspace in a separate verified cleanup.
* Reconcile project context after the mobile migration is verified.

## Rationale

Reasoning and options are recorded in [rationale.md](rationale.md).
