/**
 * Feature flags.
 *
 * The v2 surfaces (balances, deposit addresses, locked quotes, PIN withdrawals)
 * are built against the architecture in docs/ARCHITECTURE.md, which the Rust
 * backend is still implementing. These flags decide whether the app shows the
 * v1 manual-conversion flow or the v2 custodial flow.
 *
 * `EXPO_PUBLIC_*` is inlined at build time, so a production build with the flags
 * unset gets the safe defaults below.
 */

/**
 * Each `process.env.EXPO_PUBLIC_*` reference below must be written out in full,
 * statically.
 *
 * Metro inlines these by literal text substitution at build time — it does not
 * evaluate the expression. A dynamic `process.env[name]` lookup therefore
 * resolves to `undefined` in every build, silently falling through to the
 * default and making the flag unsettable. This file did exactly that until the
 * `expo/no-dynamic-env-var` rule caught it.
 */
function parse(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const features = {
  /**
   * Show the v2 custodial surfaces: balance-first home, deposit addresses,
   * locked-quote sell, PIN-gated withdrawals.
   */
  exchangeV2: parse(process.env.EXPO_PUBLIC_FEATURE_EXCHANGE_V2, true),
} as const;
