/**
 * Push notifications.
 *
 * The withdraw and gift-card screens both tell the user "you'll get a
 * notification" — this is what makes that true rather than a promise the app
 * quietly breaks.
 *
 * ## What a notification is for here
 *
 * Every event we push is something the user is *waiting on* and cannot see
 * without opening the app: a deposit credited, a payout settled or failed, a
 * gift card approved or rejected. Nothing promotional, and nothing the user
 * already knows — we don't notify that a payout was submitted, because they
 * were looking at the screen when they submitted it.
 *
 * ## Permission timing
 *
 * We do not ask on launch. A permission prompt on first open, before the user
 * has anything pending, gets denied — and on iOS a denial is close to permanent,
 * since re-asking is impossible and the user has to find it in Settings. So
 * `registerForPushNotifications` is called at the first moment a notification
 * would actually be useful: after a withdrawal or gift card submission, when the
 * user has just been told they'll hear back.
 *
 * ## Delivery
 *
 * The token goes to the backend, which sends via Expo's push service. The device
 * id ties it to one installation so a user with two phones gets both, and
 * signing out drops just that one.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { reportError } from './monitoring';

/**
 * Foreground behaviour. Banners are shown even when the app is open, because
 * these events are consequential and the user may be on an unrelated screen —
 * a payout settling while someone is reading the rates board is still news.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** The shape the backend must put in a push payload's `data`. */
export interface PushPayload {
  /** What happened. Drives nothing today but lets us branch later. */
  kind?: 'deposit' | 'payout' | 'giftcard';
  /** Activity id, so a tap can open the exact receipt. */
  activityId?: string;
}

/**
 * Asks for permission and returns an Expo push token.
 *
 * Returns null rather than throwing on every failure path — a denied permission,
 * a simulator, a missing project id. None of those are errors the user should
 * see, and none should block the flow that triggered the request.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  // Simulators and emulators can't receive push. Bailing early avoids a
  // confusing permission prompt during development.
  if (!Device.isDevice) return null;

  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;

    if (status !== 'granted') {
      // Only ask if we haven't been refused before. iOS ignores a second ask,
      // and asking again on Android is noise.
      if (!existing.canAskAgain) return null;
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }

    if (status !== 'granted') return null;

    // Android needs a channel or notifications arrive silently with no heads-up.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('transactions', {
        name: 'Transactions',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      });
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return null;

    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return token.data;
  } catch (err) {
    // Push failing must never break the flow that asked for it — a user who has
    // just submitted a withdrawal should not see an error about notifications.
    reportError(err, { flow: 'registerForPushNotifications' });
    return null;
  }
}

/**
 * Extracts our payload from a notification, whatever route it arrived by.
 *
 * Tapping a notification and receiving one while open surface the data at
 * different depths, and reading the wrong one silently yields undefined.
 */
export function readPayload(
  notification: Notifications.Notification | Notifications.NotificationResponse
): PushPayload {
  const content =
    'request' in notification
      ? notification.request.content
      : notification.notification.request.content;
  return (content?.data ?? {}) as PushPayload;
}

/** Clears the badge. Called when the app opens to a foreground state. */
export async function clearBadge(): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch {
    // Badge support is platform- and launcher-dependent; failing is harmless.
  }
}
