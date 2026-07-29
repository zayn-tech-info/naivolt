/**
 * One-time session reset across auth schema changes.
 *
 * v1 stored a JWT issued by the Express/Mongo backend, which no longer exists.
 * Those tokens can never validate again, and the onboarding flag alongside them
 * would send a returning user straight to a sign-in screen for an account the
 * new system has never heard of.
 *
 * So when the stored schema version doesn't match, everything goes: token, user,
 * and the onboarding flag. The device lands back on the first-run experience.
 * Bump AUTH_SCHEMA_VERSION any time stored auth state stops being meaningful.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearSession } from './tokenStorage';

/** 1 = Express/Mongo, password login. 2 = Rust core, passwordless. */
export const AUTH_SCHEMA_VERSION = 2;

const VERSION_KEY = 'naivolt_auth_schema_version';
export const ONBOARDING_KEY = 'naivolt_onboarding_done';

/**
 * Wipe stored auth state if it was written by an older schema.
 *
 * Returns true when a reset happened, so callers can skip the rest of hydration
 * instead of chasing a token that was just deleted.
 */
export async function resetIfStaleSchema(): Promise<boolean> {
  let stored: string | null = null;
  try {
    stored = await AsyncStorage.getItem(VERSION_KEY);
  } catch {
    // Storage unavailable (Expo Go without native modules). Treat as stale:
    // wiping a session we cannot read is safe, keeping one we cannot verify
    // is not.
  }

  if (stored === String(AUTH_SCHEMA_VERSION)) return false;

  await clearSession();
  try {
    await AsyncStorage.multiRemove([ONBOARDING_KEY]);
    await AsyncStorage.setItem(VERSION_KEY, String(AUTH_SCHEMA_VERSION));
  } catch {
    // If we cannot record the new version we will simply reset again next
    // launch — annoying, never harmful.
  }

  return true;
}

/**
 * Full sign-out, used by the profile screen's Log out action.
 *
 * Deliberately leaves the onboarding flag alone: someone signing out has already
 * seen the intro and does not need it again. Pass `{ replayOnboarding: true }`
 * to send them back to the very start.
 */
export async function signOutCompletely(
  options: { replayOnboarding?: boolean } = {},
): Promise<void> {
  await clearSession();
  if (options.replayOnboarding) {
    try {
      await AsyncStorage.removeItem(ONBOARDING_KEY);
    } catch {
      // best effort
    }
  }
}
