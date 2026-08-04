import { useEffect, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/authStore';
import { useAuthHydration } from '@/hooks/useAuthHydration';
import { useTheme } from '@/design';
import { Text } from '@/components/ui';

const SPLASH_LOGO = require('../../assets/images/icon.png');

export default function Index() {
  const router = useRouter();
  const { c, space } = useTheme();
  const { isHydrated, token, user } = useAuthStore();
  const [splashMinElapsed, setSplashMinElapsed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useAuthHydration();

  useEffect(() => {
    timerRef.current = setTimeout(() => setSplashMinElapsed(true), 3000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isHydrated || !splashMinElapsed) return;
    router.replace(token && user ? '/(tabs)/(main)' : '/(auth)/register');
  }, [isHydrated, splashMinElapsed, token, user, router]);

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
