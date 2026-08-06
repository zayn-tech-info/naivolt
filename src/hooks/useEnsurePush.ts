/**
 * Requests push permission at the moment it's earned.
 *
 * Called after a withdrawal or gift card submission — the point where the app
 * has just told the user "you'll get a notification", so the prompt explains
 * itself. Asking on first launch instead gets denied by people who have no idea
 * what the app would notify them about, and on iOS a denial is effectively
 * permanent: the system won't show the prompt twice, and recovering means the
 * user finding the app in Settings.
 *
 * Everything here fails silently. A user who has just moved money must never see
 * an error about notifications — the transfer succeeded, which is what matters.
 */

import { useCallback } from 'react';
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import { exchange } from '@/services/v2';
import { registerForPushNotifications } from '@/services/notifications';

/**
 * A stable per-installation id.
 *
 * Not a user id and not a hardware id — it changes on reinstall, which is the
 * behaviour we want: a reinstalled app is a new push target, and the old token
 * is dead anyway.
 */
async function getDeviceId(): Promise<string> {
  try {
    if (Platform.OS === 'android') {
      return Application.getAndroidId() ?? 'unknown-android';
    }
    return (await Application.getIosIdForVendorAsync()) ?? 'unknown-ios';
  } catch {
    return 'unknown';
  }
}

export function useEnsurePush() {
  return useCallback(async () => {
    try {
      const token = await registerForPushNotifications();
      if (!token) return;

      await exchange.registerPushToken({
        token,
        deviceId: await getDeviceId(),
        platform: Platform.OS === 'android' ? 'android' : 'ios',
      });
    } catch {
      // Deliberately swallowed — see the note above.
    }
  }, []);
}
