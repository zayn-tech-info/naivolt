/**
 * Spacing, radius, elevation and motion tokens.
 *
 * Spacing is a 4pt grid exposed as intent rather than as t-shirt sizes, so a
 * screen reads `space.section` instead of `theme.spacing.lg` and the meaning
 * survives a value change.
 */

import { Platform, type ViewStyle } from 'react-native';

export const space = {
  none: 0,
  hair: 2,
  tight: 4,
  snug: 8,
  base: 12,
  comfy: 16,
  roomy: 20,
  generous: 24,
  section: 28,
  spacious: 32,
  major: 40,
  jumbo: 48,
  hero: 56,
} as const;

/**
 * Radii — Convert’s cards are the app-wide reference (~16).
 *
 *  - `card` / `tile` / `field` / `control`: soft rounded surfaces (cards, list
 *    shells, inputs, buttons, icon wells). Same value on purpose so redesigned
 *    screens do not drift.
 *  - `chip`: true pills only (selected indicators, status chips, circular wells).
 *  - `sheet`: top corners of bottom sheets, slightly softer than cards.
 */
export const radius = {
  chip: 999,
  control: 16,
  field: 16,
  card: 16,
  sheet: 24,
  tile: 16,
} as const;

export const iconSize = {
  small: 16,
  medium: 20,
  large: 24,
} as const;

/** Standard touch target. Anything tappable clears 44pt. */
export const hitSlop = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const minTouch = 48;

/**
 * Elevation. Dark UIs get depth from surface lightness, not from shadow, so
 * shadows here are subtle and exist mainly to lift sheets and the tab bar off
 * the content behind them.
 */
export function elevation(level: 0 | 1 | 2 | 3): ViewStyle {
  if (level === 0) return {};
  const ios: Record<number, ViewStyle> = {
    1: {
      shadowColor: '#000',
      shadowOpacity: 0.18,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
    },
    2: {
      shadowColor: '#000',
      shadowOpacity: 0.24,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 6 },
    },
    3: {
      shadowColor: '#000',
      shadowOpacity: 0.34,
      shadowRadius: 32,
      shadowOffset: { width: 0, height: 14 },
    },
  };
  return Platform.select({
    ios: ios[level],
    android: { elevation: level * 4 },
    default: ios[level],
  }) as ViewStyle;
}

/**
 * Motion.
 *
 * One spring for anything a finger is touching (it needs to feel physical),
 * one timing curve for anything appearing or disappearing (it needs to feel
 * composed). Durations stay under 300ms — this is a payments app, not a
 * showreel, and every extra frame is latency the user reads as slowness.
 */
export const motion = {
  /** Press feedback: fast, slightly damped, no visible overshoot. */
  press: { damping: 26, stiffness: 420, mass: 0.7 },
  /** Value landing in place: a touch of overshoot to draw the eye. */
  settle: { damping: 18, stiffness: 240, mass: 0.9 },
  duration: {
    instant: 80,
    fast: 160,
    base: 240,
    slow: 420,
  },
  /** Scale a control drops to while held. */
  pressScale: 0.97,
  /** Stagger between items in an entrance sequence. */
  stagger: 45,
} as const;

/** Opacity applied to a disabled control. */
export const disabledOpacity = 0.4;
