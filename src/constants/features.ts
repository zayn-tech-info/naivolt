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

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const features = {
  /**
   * Show the v2 custodial surfaces: balance-first home, deposit addresses,
   * locked-quote sell, PIN-gated withdrawals.
   */
  exchangeV2: flag('EXPO_PUBLIC_FEATURE_EXCHANGE_V2', true),

  /**
   * Serve v2 data from the in-memory fixture instead of the API.
   *
   * Defaults to on **in development only**, so the new screens are reviewable
   * today without a backend. A release build has to opt in explicitly, because
   * the failure mode of getting this wrong is an app that shows someone a
   * fabricated balance — and defaulting a money path to fixture data on the
   * strength of an unset environment variable is not a risk worth taking to save
   * one line of build config.
   */
  useMockExchange: flag('EXPO_PUBLIC_USE_MOCK_EXCHANGE', __DEV__),
} as const;
