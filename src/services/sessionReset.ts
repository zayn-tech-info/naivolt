/**
 * One-time session reset across auth schema changes.
 *
 * v1 stored a JWT issued by the Express/Mongo backend, which no longer exists.
 * Those tokens can never validate again.
 *
 * So when the stored schema version does not match, the token and user are
 * cleared. The device lands back on authentication.
 * Bump AUTH_SCHEMA_VERSION any time stored auth state stops being meaningful.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearSession } from './tokenStorage';

/** 1 = Express/Mongo, password login. 2 = Rust core, passwordless. */
export const AUTH_SCHEMA_VERSION = 2;

const VERSION_KEY = 'naivolt_auth_schema_version';

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
 * The app has no onboarding route while the replacement experience is being
 * designed, so sign out returns directly to authentication.
 */
export async function signOutCompletely(): Promise<void> {
  await clearSession();
}
