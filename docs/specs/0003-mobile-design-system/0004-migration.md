# Migration

## Summary

The system moves through complete user journeys. New code follows the standard immediately. Legacy modules remain only until their final consumer moves.

## Order

1. Home and navigation.
2. Authentication.
3. Sell, deposit, withdrawal, and confirmation flows.
4. Activity and account.
5. Remove the legacy theme, obsolete primitives, and temporary audit exceptions.

## Journey completion rule

A journey is complete only when light theme, dark theme, large text, reduced motion, loading, empty, error, and compact width states are verified. A legacy component is removed only after repository search confirms that no consumer remains.

## Compatibility

No backend contract or financial calculation changes. Existing routes remain stable. Theme storage migrates the old saved light or dark value into the new three choice preference without losing the user choice.

## Rollback

Each journey remains a focused change that can be reverted without reverting completed journeys. Shared token changes land before consumers so a journey never imports a missing contract.
