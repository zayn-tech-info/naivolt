/**
 * Naivolt type system.
 *
 * Two faces, with a rule about which does what:
 *
 *   Instrument Sans — everything a person reads, **including money**. A
 *   grotesque with slightly narrow proportions and real character in the
 *   lowercase, so headings have a voice without needing weight 800 to get there.
 *   Balances and amounts sit in it too: a naira figure is something you read,
 *   not something you audit character by character, and the sans keeps the
 *   balance feeling like part of the interface rather than like a terminal.
 *
 *   Geist Mono — reserved for strings that must be verified glyph by glyph, and
 *   nothing else: wallet addresses, tx hashes, references, countdowns and
 *   confirmation counters. Monospace here is a signal that says "check this
 *   exactly", which only works while it stays rare.
 *
 * Figures still align. `tabular` (below) is applied to the numeric variants
 * regardless of face, so digits don't shift horizontally as a value ticks and
 * columns of amounts line up.
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
  /** The balance. One per screen, clear and calm. */
  display: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 40,
    lineHeight: 48,
    letterSpacing: -1.2,
  },
  /** Secondary large figures: quote totals, payout amounts. */
  figure: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 30,
    lineHeight: 38,
    letterSpacing: -0.8,
  },
  /** Screen titles. */
  title: {
    fontFamily: fontFamily.sansBold,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: -0.6,
  },
  /** Section headings. */
  heading: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.3,
  },
  /** Card titles, list row primaries. */
  subheading: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: -0.1,
  },
  /** Running text. */
  body: {
    fontFamily: fontFamily.sans,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: -0.1,
  },
  bodySmall: {
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0,
  },
  /** Button and control text. */
  action: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 16,
    lineHeight: 20,
    letterSpacing: -0.1,
  },
  /** Field labels, metadata. */
  label: {
    fontFamily: fontFamily.sansMedium,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0,
  },
  /**
   * The utility register: tracked-out uppercase for eyebrows and section
   * markers. Carries structure without adding another large bold heading.
   */
  eyebrow: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.8,
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
    fontFamily: fontFamily.sansMedium,
    fontSize: 16,
    lineHeight: 20,
    letterSpacing: -0.2,
  },
  amountSmall: {
    fontFamily: fontFamily.sansMedium,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.1,
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
  default: { fontVariant: ['tabular-nums'] },
}) as TextStyle;
