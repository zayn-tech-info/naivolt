/**
 * Unlock — the returning user's way in.
 *
 * Someone who has signed in before and still holds a valid refresh token should
 * not be sent back through SMS. They have already proved they own the number;
 * asking again on every cold start is friction that buys nothing and costs a
 * real SMS each time.
 *
 * So: refresh token proves *this device* was signed in, PIN proves *this person*
 * is holding it. Both are required, so a stolen phone with a live token still
 * cannot get in, and a known PIN is useless without the device.
 *
 * The PIN is verified server-side against the stored hash. Nothing derived from
 * it is written to the device, so a phone dump yields nothing to brute-force
 * offline — which is the whole reason this is a network call rather than a local
 * comparison.
 *
 * There is always a way out. A user who has forgotten their PIN, or is on
 * someone else's phone, can sign in with a number instead — a lock screen with
 * no escape hatch is a support ticket.
 */

import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/design';
import { Button, PinPad, Screen, Text } from '@/components/ui';
import { Avatar } from '@/components/ui';
import { unlockWithPin } from '@/services/authV2';
import {
  clearSession,
  getSavedUser,
  getToken,
  REFRESH_KEY,
  saveUser,
  setToken as persistToken,
  TOKEN_KEY,
} from '@/services/tokenStorage';
import { useAuthStore } from '@/store/authStore';
import type { User } from '@/store/authStore';

/**
 * Wrong attempts before we stop offering the PIN.
 *
 * Not a lockout — the session is simply dropped and the user signs in with a
 * number, which is a path they can always complete. Locking someone out of
 * their own money because they mistyped six digits is the worse failure.
 */
const MAX_ATTEMPTS = 5;

export default function UnlockScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const { setUser, setToken } = useAuthStore();

  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [user, setLocalUser] = useState<User | null>(null);

  // The saved user is only for the greeting — the session is what authorises.
  useEffect(() => {
    getSavedUser()
      .then((saved) => setLocalUser((saved as User) ?? null))
      .catch(() => {});
  }, []);

  const signInInstead = useCallback(async () => {
    await clearSession();
    useAuthStore.getState().logout();
    router.replace('/(auth)/register');
  }, [router]);

  const submit = useCallback(
    async (entered: string) => {
      setBusy(true);
      try {
        const refreshToken = await getToken(REFRESH_KEY);
        if (!refreshToken) {
          // Nothing to unlock against; the only honest move is a full sign-in.
          await signInInstead();
          return;
        }

        const session = await unlockWithPin(refreshToken, entered);

        await persistToken(TOKEN_KEY, session.token);
        // Refresh tokens rotate on every use, so the old one is already dead.
        await persistToken(REFRESH_KEY, session.refreshToken);
        setToken(session.token);
        if (user) {
          setUser(user);
          await saveUser(user);
        }

        router.replace('/(tabs)/(main)');
      } catch {
        const next = attempts + 1;
        setAttempts(next);
        setError(true);

        if (next >= MAX_ATTEMPTS) {
          await signInInstead();
        }
      } finally {
        setBusy(false);
      }
    },
    [attempts, router, setToken, setUser, signInInstead, user],
  );

  const remaining = MAX_ATTEMPTS - attempts;

  return (
    <Screen edges={['top', 'bottom']} scroll={false}>
      <View style={{ flex: 1, justifyContent: 'space-between', paddingVertical: space.roomy }}>
        <View style={{ alignItems: 'center', gap: space.base, marginTop: space.major }}>
          <Avatar name={user?.displayName ?? user?.name} seed={user?.avatarSeed} size={64} />

          <Text variant="title" align="center" style={{ marginTop: space.snug }}>
            {user?.displayName || user?.name ? `Welcome back` : 'Enter your PIN'}
          </Text>
          <Text variant="bodySmall" color="secondaryText" align="center">
            {user?.displayName || user?.name
              ? `Enter your PIN to open your account`
              : 'Enter your PIN to continue'}
          </Text>
        </View>

        <PinPad
          value={pin}
          onChange={setPin}
          error={error}
          onErrorShown={() => setError(false)}
          onComplete={submit}
        />

        <View style={{ alignItems: 'center', gap: space.snug, minHeight: 64 }}>
          {busy ? (
            <Text variant="caption" color="tertiaryText">
              Checking…
            </Text>
          ) : attempts > 0 ? (
            <Text variant="caption" color="negative">
              Wrong PIN. {remaining} {remaining === 1 ? 'try' : 'tries'} left.
            </Text>
          ) : null}

          <Button
            title="Sign in with your number instead"
            variant="ghost"
            onPress={signInInstead}
          />
        </View>
      </View>
    </Screen>
  );
}
