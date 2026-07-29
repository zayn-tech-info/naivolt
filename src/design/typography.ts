/**
 * Naivolt type system.
 *
 * Two faces, with a hard rule about which does what:
 *
 *   Instrument Sans — everything a person reads. A grotesque with slightly
 *   narrow proportions and real character in the lowercase, so headings have a
 *   voice without needing weight 800 to get there.
 *
 *   Geist Mono — every number that represents money, and every string that
 *   must be verified character by character: balances, rates, amounts, wallet
 *   addresses, tx hashes, confirmation counts, OTP and PIN digits.
 *
 * The mono rule is the deliberate choice in this design. The backend is a
 * double-entry ledger where exact digits are the entire product, and a
 * monospaced numeral says "this figure is exact" in a way a proportional face
 * cannot. It also fixes a real problem for free: digits stop shifting
 * horizontally as values tick, and it gives Android the tabular alignment that
 * `fontVariant: ['tabular-nums']` only delivers on iOS.
 *
 * Weights are named, never inlined. If a style isn't in this file it doesn't
 * exist — that constraint is what stops the ad-hoc 10/11/12/13/14/15/16/18px
 * sprawl from growing back.
 */

import { Platform, type TextStyle } from 'react-native';

export const fontFamily = {
  sans: 'InstrumentSans_400Regular',
  sansMedium: 'InstrumentSans_500Medium',
  sansSemibold: 'InstrumentSans_600SemiBold',
  sansBold: 'InstrumentSans_700Bold',

  mono: 'GeistMono_400Regular',
  monoMedium: 'GeistMono_500Medium',
  monoSemibold: 'GeistMono_600SemiBold',
} as const;

/**
 * The ramp. Sizes step at a consistent ratio rather than landing wherever a
 * screen happened to need something, and each entry carries its own line
 * height and tracking — the three are one decision, not three.
 */
export const type = {
  /** The balance. One per screen, mono, tight. */
  display: {
    fontFamily: fontFamily.mono,
    fontSize: 44,
    lineHeight: 48,
    letterSpacing: -2,
  },
  /** Secondary large figures: quote totals, payout amounts. */
  figure: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -1.2,
  },
  /** Screen titles. */
  title: {
    fontFamily: fontFamily.sansBold,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.6,
  },
  /** Section headings. */
  heading: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 19,
    lineHeight: 25,
    letterSpacing: -0.3,
  },
  /** Card titles, list row primaries. */
  subheading: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.1,
  },
  /** Running text. */
  body: {
    fontFamily: fontFamily.sans,
    fontSize: 15,
    lineHeight: 22,
    letterSpacing: -0.1,
  },
  bodySmall: {
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 19,
    letterSpacing: 0,
  },
  /** Button and control text. */
  action: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.1,
  },
  /** Field labels, metadata. */
  label: {
    fontFamily: fontFamily.sansMedium,
    fontSize: 13,
    lineHeight: 17,
    letterSpacing: 0,
  },
  /**
   * The utility register: tracked-out uppercase for eyebrows and section
   * markers. Carries structure without adding another large bold heading.
   */
  eyebrow: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.1,
    textTransform: 'uppercase' as const,
  },
  caption: {
    fontFamily: fontFamily.sans,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
  },

  // ── Mono registers ────────────────────────────────────────────────
  /** Inline money inside rows and cards. */
  amount: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: -0.4,
  },
  amountSmall: {
    fontFamily: fontFamily.mono,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: -0.3,
  },
  /** Addresses, hashes, references. */
  code: {
    fontFamily: fontFamily.mono,
    fontSize: 13,
    lineHeight: 20,
    letterSpacing: -0.2,
  },
  /** Countdowns and confirmation counters. */
  ticker: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0,
  },
} as const;

export type TypeToken = keyof typeof type;

/**
 * iOS renders tabular figures natively; on Android the mono face is doing that
 * job already. Applied to mono styles so proportional fallbacks (before fonts
 * finish loading) still align.
 */
export const tabular: TextStyle = Platform.select({
  ios: { fontVariant: ['tabular-nums'] },
  default: {},
}) as TextStyle;
