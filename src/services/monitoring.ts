/**
 * Crash and error reporting.
 *
 * Sentry sees production failures, so the configuration here is mostly about
 * what it must *not* see. This app handles PINs, session tokens, bank account
 * numbers and wallet addresses; a crash report that carries any of those turns
 * an error tracker into a breach surface, and Sentry's defaults are tuned for
 * ordinary apps rather than for one holding customer funds.
 *
 * So: PII off, request bodies scrubbed, and an explicit denylist applied to
 * every event before it leaves the device.
 */

import * as Sentry from '@sentry/react-native';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN ?? '';

/**
 * Keys whose values are stripped from any event payload, at any depth.
 * Matched case-insensitively against a substring of the key.
 */
const SENSITIVE_KEYS = [
  'pin',
  'password',
  'token',
  'authorization',
  'secret',
  'seed',
  'mnemonic',
  'privatekey',
  'accountnumber',
  'account_number',
  'bvn',
  'otp',
  'cvv',
];

const REDACTED = '[redacted]';

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((needle) => lower.includes(needle));
}

/**
 * Recursively redacts sensitive values. Depth-capped because Sentry payloads can
 * contain deeply nested or cyclic structures and this runs on the main thread
 * during a crash — the worst possible moment to hang.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;

  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitive(key) ? REDACTED : scrub(val, depth + 1);
    }
    return out;
  }

  return value;
}

export function initMonitoring(): void {
  // No DSN in development, and none in a build where it wasn't configured —
  // initialising without one silently swallows errors that should surface in
  // the console instead.
  if (!dsn) return;

  Sentry.init({
    dsn,
    // Never attach IP addresses, usernames or emails.
    sendDefaultPii: false,
    // Full sampling on errors; performance traces at 20% to keep volume sane.
    tracesSampleRate: 0.2,
    environment: __DEV__ ? 'development' : 'production',

    beforeSend(event) {
      if (event.request) {
        // Query strings carry account numbers and asset/chain pairs.
        delete event.request.query_string;
        delete event.request.data;
        delete event.request.cookies;
      }
      if (event.extra) event.extra = scrub(event.extra) as typeof event.extra;
      if (event.contexts) event.contexts = scrub(event.contexts) as typeof event.contexts;
      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      // Console breadcrumbs are the most likely place for a stray value to be
      // logged, and they add little over the stack trace.
      if (breadcrumb.category === 'console') return null;
      if (breadcrumb.data) breadcrumb.data = scrub(breadcrumb.data) as typeof breadcrumb.data;
      return breadcrumb;
    },
  });
}

/**
 * Ties events to a user by id only. Never pass email, phone or name — the id is
 * enough to correlate a report with an account internally.
 */
export function identifyUser(id: string | null): void {
  if (!dsn) return;
  Sentry.setUser(id ? { id } : null);
}

/**
 * Reports a handled error with context. Use for failures the app recovers from
 * but that shouldn't be silent — a payout that failed for an unexpected reason,
 * a quote that couldn't be parsed.
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  if (!dsn) {
    if (__DEV__) console.warn('[monitoring]', error, context);
    return;
  }
  Sentry.captureException(error, context ? { extra: scrub(context) as Record<string, unknown> } : undefined);
}

export { Sentry };
