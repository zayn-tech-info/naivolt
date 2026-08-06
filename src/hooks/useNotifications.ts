/**
 * Notification wiring for the app shell.
 *
 * Two jobs:
 *
 *  1. **Route a tap.** A notification about a payout should open that payout,
 *    not the home screen. Landing on home and making the user find the
 *    transaction defeats the point of telling them about it.
 *  2. **Refresh on arrival.** A notification means something changed server-side,
 *    so the balance and activity caches are stale by definition. Invalidating
 *    them means a user who opens the app from a banner sees the new state
 *    immediately rather than the figure from before.
 *
 * Handles the cold-start case too: if the app was killed and launched *by* the
 * tap, there's no listener event to catch — the response is waiting in
 * `getLastNotificationResponseAsync` instead, and missing that is the usual way
 * deep-linked notifications appear to work in testing and fail in the wild.
 */

import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { clearBadge, readPayload } from '@/services/notifications';
import { exchangeKeys } from './useExchange';

export function useNotificationRouting() {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Guards against handling the same cold-start response twice if the shell
  // remounts (a theme change, a fast refresh).
  const handledColdStart = useRef(false);

  useEffect(() => {
    const openFromPayload = (payload: ReturnType<typeof readPayload>) => {
      if (payload.activityId) {
        router.push({ pathname: '/activity/[id]', params: { id: payload.activityId } });
      }
    };

    const refreshStaleData = () => {
      queryClient.invalidateQueries({ queryKey: exchangeKeys.portfolio });
      queryClient.invalidateQueries({ queryKey: exchangeKeys.activity });
    };

    // Cold start: the app was launched by tapping a notification.
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response || handledColdStart.current) return;
        handledColdStart.current = true;
        refreshStaleData();
        openFromPayload(readPayload(response));
      })
      .catch(() => {});

    // Tapped while the app was already running or backgrounded.
    const tapSub = Notifications.addNotificationResponseReceivedListener((response) => {
      refreshStaleData();
      openFromPayload(readPayload(response));
    });

    // Arrived while the app was open — refresh, but don't navigate. Yanking
    // someone off the screen they're using is hostile, even for good news.
    const receiveSub = Notifications.addNotificationReceivedListener(() => {
      refreshStaleData();
    });

    clearBadge();

    return () => {
      tapSub.remove();
      receiveSub.remove();
    };
  }, [router, queryClient]);
}
