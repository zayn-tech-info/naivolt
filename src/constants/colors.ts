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
  primaryBackground: '#08090A', // canvas — the app floor
  surface: '#101215', // resting cards
  surfaceElevated: '#171A1E', // raised: sheets, active states
  surfaceOverlay: '#1F242A', // highest: menus, tooltips
  surfaceInput: '#050607', // wells read as recessed, below the canvas
  surfaceSunken: '#050607',

  // ── Action ────────────────────────────────────────────────────────
  primaryAccent: '#AAFF00', // brand lime — actions only
  accentPressed: '#93DD00',
  accentDim: 'rgba(170, 255, 0, 0.10)',
  accentEdge: 'rgba(170, 255, 0, 0.22)',
  buttonTextOnAccent: '#0A0F00',

  // ── Text ──────────────────────────────────────────────────────────
  primaryText: '#F2F4F5',
  secondaryText: '#8B939C',
  tertiaryText: '#5B636B',
  quaternaryText: '#3C4349',

  // ── Structure ─────────────────────────────────────────────────────
  border: '#1C2126',
  borderLight: '#2A3037',
  hairline: 'rgba(255, 255, 255, 0.06)',

  // ── Status: money states, deliberately not lime ───────────────────
  positive: '#3DD68C', // credited, paid, confirmed
  positiveDim: 'rgba(61, 214, 140, 0.12)',
  warning: '#FFB020', // pending, awaiting confirmations
  warningDim: 'rgba(255, 176, 32, 0.12)',
  negative: '#FF5A5A', // failed, rejected, wrong network
  negativeDim: 'rgba(255, 90, 90, 0.12)',
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
  primaryBackground: '#FAFAFA',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  surfaceOverlay: '#FFFFFF',
  surfaceInput: '#F2F3F5',
  surfaceSunken: '#F0F1F3',

  // Lime on white fails contrast at text sizes, so the light theme runs a
  // darkened brand green for anything that carries a label.
  primaryAccent: '#4F7D00',
  accentPressed: '#3F6600',
  accentDim: 'rgba(79, 125, 0, 0.10)',
  accentEdge: 'rgba(79, 125, 0, 0.20)',
  buttonTextOnAccent: '#FFFFFF',

  primaryText: '#0C0E10',
  secondaryText: '#5C646D',
  tertiaryText: '#8A929B',
  quaternaryText: '#B4BAC1',

  border: '#E6E8EB',
  borderLight: '#D6D9DD',
  hairline: 'rgba(0, 0, 0, 0.07)',

  positive: '#0F9D58',
  positiveDim: 'rgba(15, 157, 88, 0.10)',
  warning: '#B45309',
  warningDim: 'rgba(180, 83, 9, 0.10)',
  negative: '#D92D20',
  negativeDim: 'rgba(217, 45, 32, 0.10)',
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
