# Naivolt mobile design system

**Source**: Confirmed modern retail fintech direction in spec 0003

## Character

Naivolt is calm, exact, and quietly confident. Neutral surfaces carry financial content. Refined emerald marks the one action or selected state that needs attention.

Expressive motion belongs to brand and success moments. Forms, lists, and reading surfaces remain composed. Lime is a small brand spark, never a large content surface.

## Build mandate

1. Use Instrument Sans for interface copy and money. Use Geist Mono only for OTP, PIN, wallet addresses, and transaction references.
2. Use the palette in `src/constants/colors.ts`. Accent color marks actions and does not decorate headings.
3. Use spacing, radius, motion, and touch tokens from `src/design/tokens.ts`.
4. Use type tokens from `src/design/typography.ts`. Do not invent local font sizes or weights.
5. Prefer complete product surfaces with a clear hierarchy, useful copy, real states, and no dead space.
6. Motion may be expressive in brand and success moments. Every sequence needs a reduced motion form.
7. Reuse local product and crypto assets before adding an external image dependency.

## Composition patterns

1. Auth screens use one strong visual, one clear heading, short supporting copy, and vertically ordered actions.
2. Primary actions use the accent surface. Provider actions use the secondary surface.
3. Forms reveal detail only when needed and preserve a clear path back to the previous choice.
4. Small screens keep controls and key copy visible when the keyboard opens.
5. Home uses a flat balance surface panel, a separate quick action row, and clear activity sections.
6. Tab screens use one top level header. Focused flows use one back and title header.

## Responsive behavior

1. Design for compact phone widths first.
2. Decorative media may compress when an input is active.
3. Every interactive target is at least 48 points in both dimensions.
4. Content scrolls when height is constrained rather than clipping controls or legal copy.
5. Text reflows at larger device settings. Long balances step down through defined type roles before using a second line.
