import { useEffect, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/authStore';
import { useAuthHydration } from '@/hooks/useAuthHydration';
import { getToken, REFRESH_KEY } from '@/services/tokenStorage';
import { useTheme } from '@/design';
import { Text } from '@/components/ui';

const SPLASH_LOGO = require('../../assets/images/icon.png');

export default function Index() {
  const router = useRouter();
  const { c, space } = useTheme();
  const { isHydrated, token, user } = useAuthStore();
  const [splashMinElapsed, setSplashMinElapsed] = useState(false);
  // undefined until checked, so we never route on a value we do not have yet.
  const [canUnlock, setCanUnlock] = useState<boolean | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useAuthHydration();

  // A live refresh token means this device has signed in before and can be
  // reopened with a PIN. Checked here rather than in the store because it is a
  // routing question, not session state.
  useEffect(() => {
    getToken(REFRESH_KEY)
      .then((t) => setCanUnlock(!!t))
      .catch(() => setCanUnlock(false));
  }, []);

  useEffect(() => {
    timerRef.current = setTimeout(() => setSplashMinElapsed(true), 3000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isHydrated || !splashMinElapsed || canUnlock === undefined) return;

    // Already holding a live access token — straight in, no gate. Locking a
    // user out of a session they never left would be friction for its own sake.
    if (token && user) {
      router.replace('/(tabs)/(main)');
      return;
    }

    // Signed in before, access token has simply expired: ask for the PIN rather
    // than another SMS.
    router.replace(canUnlock ? '/(auth)/unlock' : '/(auth)/register');
  }, [isHydrated, splashMinElapsed, token, user, canUnlock, router]);

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.primaryBackground,
      }}
    >
      <Image source={SPLASH_LOGO} style={{ width: space.hero * 3, height: space.hero * 3 }} resizeMode="contain" />
      <Text variant="title" color="primaryAccent" style={{ marginTop: space.roomy }}>
        Naivolt
      </Text>
    </View>
  );
}
