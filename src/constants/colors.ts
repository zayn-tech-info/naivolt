/**
 * Naivolt palette.
 *
 * Two rules hold this together:
 *
 *  1. Lime is the action colour and nothing else. It marks the one thing on a
 *     screen we want tapped. It is never used for status, never for money,
 *     never for decoration. Previously `success`/`paid`/`primaryAccent` were
 *     all the same lime, which is why every screen read as one flat plane.
 *
 *  2. Depth comes from layered surfaces, not from borders. `canvas` →
 *     `surface` → `surfaceElevated` is a real elevation ladder. Hairlines are
 *     for input affordances and list separators only.
 *
 * Status carries its own family: green for money that arrived, amber for
 * money in flight, red for money that failed. Those are informational and
 * must not compete with the action colour.
 */

export const darkColors = {
  // ── Elevation ladder ──────────────────────────────────────────────
  primaryBackground: '#0B0D10',
  surface: '#12151A',
  surfaceElevated: '#191D23',
  surfaceOverlay: '#20252D',
  surfaceInput: '#191D23',
  surfaceSunken: '#080A0D',

  // ── Action ────────────────────────────────────────────────────────
  primaryAccent: '#45D6A0',
  accentPressed: '#35BC8A',
  accentDim: 'rgba(69, 214, 160, 0.12)',
  accentEdge: 'rgba(69, 214, 160, 0.30)',
  buttonTextOnAccent: '#07251C',
  brandSpark: '#B7F34A',

  // Deep money panel on home (white type sits on top)
  balancePanel: '#053D2E',
  balancePanelEdge: 'rgba(69, 214, 160, 0.28)',
  balancePanelText: '#FFFFFF',
  balancePanelMuted: 'rgba(255, 255, 255, 0.72)',
  balancePanelControl: 'rgba(255, 255, 255, 0.14)',

  // ── Text ──────────────────────────────────────────────────────────
  primaryText: '#F4F6F8',
  secondaryText: '#A2A9B3',
  tertiaryText: '#77808B',
  quaternaryText: '#59616B',

  // ── Structure ─────────────────────────────────────────────────────
  border: '#252A32',
  borderLight: '#343B45',
  hairline: 'rgba(255, 255, 255, 0.09)',

  // ── Status: money states, deliberately not lime ───────────────────
  positive: '#3DD68C', // credited, paid, confirmed
  positiveDim: 'rgba(61, 214, 140, 0.12)',
  warning: '#FFB020', // pending, awaiting confirmations
  warningDim: 'rgba(255, 176, 32, 0.12)',
  negative: '#FF5A5A', // failed, rejected, wrong network
  negativeDim: 'rgba(255, 90, 90, 0.12)',
  /** Irreversible-risk UI (wrong network, permanent loss). Same ink as negative. */
  danger: '#FF5A5A',
  dangerDim: 'rgba(255, 90, 90, 0.14)',
  info: '#63A0FF',
  infoDim: 'rgba(99, 160, 255, 0.12)',

  // ── Legacy aliases — keep existing screens compiling ──────────────
  success: '#3DD68C',
  successDim: 'rgba(61, 214, 140, 0.12)',
  error: '#FF5A5A',
  pending: '#FFB020',
  paid: '#3DD68C',
} as const;

export const lightColors = {
  primaryBackground: '#F7F8FA',
  surface: '#FFFFFF',
  surfaceElevated: '#F1F3F5',
  surfaceOverlay: '#FFFFFF',
  surfaceInput: '#F1F3F5',
  surfaceSunken: '#ECEFF2',

  // Lime on white fails contrast at text sizes, so the light theme runs a
  // darkened brand green for anything that carries a label.
  primaryAccent: '#0B7A53',
  accentPressed: '#086542',
  accentDim: 'rgba(11, 122, 83, 0.10)',
  accentEdge: 'rgba(11, 122, 83, 0.24)',
  buttonTextOnAccent: '#FFFFFF',
  brandSpark: '#9DDC2C',

  // Deep money panel on home (white type sits on top)
  balancePanel: '#0A5C40',
  balancePanelEdge: 'rgba(7, 37, 28, 0.20)',
  balancePanelText: '#FFFFFF',
  balancePanelMuted: 'rgba(255, 255, 255, 0.78)',
  balancePanelControl: 'rgba(255, 255, 255, 0.16)',

  primaryText: '#101114',
  secondaryText: '#5F6670',
  tertiaryText: '#747C86',
  quaternaryText: '#9AA1AA',

  border: '#E4E7EB',
  borderLight: '#CFD4DA',
  hairline: 'rgba(16, 17, 20, 0.09)',

  positive: '#0F9D58',
  positiveDim: 'rgba(15, 157, 88, 0.10)',
  warning: '#B45309',
  warningDim: 'rgba(180, 83, 9, 0.10)',
  negative: '#D92D20',
  negativeDim: 'rgba(217, 45, 32, 0.10)',
  /** Irreversible-risk UI (wrong network, permanent loss). Same ink as negative. */
  danger: '#D92D20',
  dangerDim: 'rgba(217, 45, 32, 0.12)',
  info: '#1D4ED8',
  infoDim: 'rgba(29, 78, 216, 0.10)',

  success: '#0F9D58',
  successDim: 'rgba(15, 157, 88, 0.10)',
  error: '#D92D20',
  pending: '#B45309',
  paid: '#0F9D58',
} as const;

export type Colors = { readonly [K in keyof typeof darkColors]: string };

/** Default export for files not yet migrated to useColors(). */
export const colors = darkColors;
