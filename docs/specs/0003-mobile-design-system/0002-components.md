# Canonical components

## Summary

Screens compose the product from one shared component library. Shared components own typography, interaction states, accessibility, geometry, and theme behavior so screens only decide content and flow.

## Canonical library

* `Text` owns every interface type role.
* `Money` owns currency formatting, tabular digits, privacy, and spoken values.
* `Button` owns primary, secondary, text, and destructive actions.
* `Input` owns filled fields, labels, help, error text, and focus state.
* `Surface` owns tonal cards, hairlines, and floating elevation.
* `Screen` owns safe area, scrolling, gutter, section rhythm, and keyboard behavior.
* `Badge` owns semantic status.
* `IconButton` owns compact icon actions.
* `QuickAction` owns circular action wells and labels.
* `TopLevelHeader` owns tab screen context and account access.
* `FlowHeader` owns back navigation, title, and an optional trailing action.
* `MainTabBar` owns fixed bottom navigation with labels.
* `FeedbackState` owns loading, empty, recoverable error, and success presentation.

## Interaction hierarchy

Each screen may have one filled emerald primary action. Secondary actions use neutral surfaces. Tertiary actions use text. Destructive actions use the negative semantic family and require clear copy.

## Form pattern

Fields use a neutral filled surface, a persistent label, helper or error text, and an emerald focus ring. Validation stays close to the field. Screen errors use `FeedbackState` with a retry action when recovery is possible.

## Enforcement

Product screens import shared components from `@/components/ui`. ESLint blocks direct React Native text, legacy theme imports, raw palette imports, and direct shared component file imports. A design audit reports raw colors, local font sizes, unsupported curves, and legacy components.
