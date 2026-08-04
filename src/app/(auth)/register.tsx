/**
 * The shared entry for signup and signin.
 *
 * Authentication stays passwordless. The visual hero establishes the product
 * before the user chooses Google, Apple, or phone.
 */

import { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { useTheme } from '@/design';
import { Button, Input, Text } from '@/components/ui';
import { CryptoLogoMarquee } from '@/components/auth/CryptoLogoMarquee';
import { LightAuthScreen } from '@/components/auth/LightAuthScreen';
import { useAuthStore } from '@/store/authStore';
import { saveUser, setToken as persistToken, TOKEN_KEY } from '@/services/tokenStorage';
import { AuthError, normalizePhone, requestOtp, signInWithIdToken } from '@/services/authV2';
import { isProviderAvailable, signInWithApple, signInWithGoogle } from '@/services/oauthProviders';

export default function AuthScreen() {
  return (
    <LightAuthScreen>
      <AuthScreenContent />
    </LightAuthScreen>
  );
}

function AuthScreenContent() {
  const router = useRouter();
  const { c, space, minTouch, hitSlop } = useTheme();
  const reduceMotion = useReducedMotion();
  const { setUser, setToken } = useAuthStore();

  const [phone, setPhone] = useState('');
  const [phoneExpanded, setPhoneExpanded] = useState(false);
  const [busy, setBusy] = useState<'google' | 'apple' | 'phone' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const phoneIsValid = normalizePhone(phone) !== null;

  const onSocial = useCallback(
    async (provider: 'google' | 'apple') => {
      setError(null);
      setBusy(provider);
      try {
        const result =
          provider === 'google' ? await signInWithGoogle() : await signInWithApple();

        if (!result) return;

        const session = await signInWithIdToken(provider, result.idToken, result.fullName);
        await persistToken(TOKEN_KEY, session.token);
        setToken(session.token);
        setUser(session.user);
        await saveUser(session.user);

        if (session.isNewAccount) {
          router.replace({ pathname: '/set-pin', params: { signup: '1' } });
        } else {
          router.replace('/(tabs)/(main)');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not sign in');
      } finally {
        setBusy(null);
      }
    },
    [router, setToken, setUser],
  );

  const onPhone = useCallback(async () => {
    setError(null);
    setBusy('phone');
    try {
      const normalized = await requestOtp(phone);
      router.push({ pathname: '/verify', params: { phone: normalized } });
    } catch (err) {
      if (err instanceof AuthError && err.offline && __DEV__) {
        const normalized = normalizePhone(phone);
        if (normalized) {
          router.push({ pathname: '/verify', params: { phone: normalized, mock: '1' } });
          return;
        }
      }
      setError(err instanceof Error ? err.message : 'Could not send code');
    } finally {
      setBusy(null);
    }
  }, [phone, router]);

  const openPhone = useCallback(() => {
    setError(null);
    setPhoneExpanded(true);
  }, []);

  const closePhone = useCallback(() => {
    setError(null);
    setPhoneExpanded(false);
  }, []);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.primaryBackground }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: space.roomy,
            paddingBottom: space.roomy,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {phoneExpanded ? (
            <>
              <Pressable
                onPress={closePhone}
                disabled={busy !== null}
                hitSlop={hitSlop}
                accessibilityRole="button"
                accessibilityLabel="Back to authentication methods"
                style={{ minHeight: minTouch, justifyContent: 'center', alignSelf: 'flex-start' }}
              >
                <Ionicons name="arrow-back" size={space.roomy} color={c.primaryText} />
              </Pressable>

              <Animated.View
                entering={reduceMotion ? undefined : FadeInDown.duration(240)}
                style={{ gap: space.comfy, marginTop: space.section }}
              >
                <Input
                  label="Phone number"
                  prefix="+234"
                  placeholder="801 234 5678"
                  value={phone}
                  onChangeText={(text) => {
                    setPhone(text);
                    setError(null);
                  }}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="telephoneNumber"
                  returnKeyType="go"
                  onSubmitEditing={phoneIsValid ? onPhone : undefined}
                  maxLength={14}
                  hint="We'll text you a 6 digit code."
                  autoFocus
                />

                <Button
                  title="Continue"
                  size="lg"
                  fullWidth
                  iconRight="arrow-forward"
                  loading={busy === 'phone'}
                  disabled={!phoneIsValid || busy !== null}
                  onPress={onPhone}
                />

                {error ? (
                    <Animated.View entering={reduceMotion ? undefined : FadeInDown.duration(200)}>
                    <Text variant="bodySmall" color="negative" accessibilityLiveRegion="polite">
                      {error}
                    </Text>
                  </Animated.View>
                ) : null}
              </Animated.View>
            </>
          ) : (
            <>
              {router.canGoBack() ? (
                <Pressable
                  onPress={() => router.back()}
                  hitSlop={hitSlop}
                  accessibilityRole="button"
                  accessibilityLabel="Go back"
                  style={{ minHeight: minTouch, justifyContent: 'center', alignSelf: 'flex-start' }}
                >
                  <Ionicons name="arrow-back" size={space.roomy} color={c.primaryText} />
                </Pressable>
              ) : (
                <View style={{ minHeight: minTouch }} />
              )}

              <CryptoLogoMarquee />

              <Animated.View
                entering={reduceMotion ? undefined : FadeIn.duration(320)}
                style={{ alignItems: 'center', marginTop: space.section }}
              >
                <Text variant="title" align="center">
                  Welcome to Naivolt
                </Text>
                <Text
                  variant="body"
                  color="secondaryText"
                  align="center"
                  style={{ marginTop: space.snug, maxWidth: space.hero * 6 }}
                >
                  Sign in or create an account in seconds. No password to remember.
                </Text>
              </Animated.View>

              <View style={{ gap: space.base, marginTop: space.section }}>
                <Button
                  title="Continue with Google"
                  icon="logo-google"
                  variant="secondary"
                  size="lg"
                  fullWidth
                  style={{ borderWidth: 1, borderColor: c.border }}
                  loading={busy === 'google'}
                  disabled={busy !== null}
                  onPress={() => onSocial('google')}
                />

                {Platform.OS === 'ios' && isProviderAvailable('apple') ? (
                  <Button
                    title="Continue with Apple"
                    icon="logo-apple"
                    variant="secondary"
                    size="lg"
                    fullWidth
                    style={{ borderWidth: 1, borderColor: c.border }}
                    loading={busy === 'apple'}
                    disabled={busy !== null}
                    onPress={() => onSocial('apple')}
                  />
                ) : null}
              </View>

              <Divider />

              <Button
                title="Continue with phone"
                icon="call-outline"
                size="lg"
                fullWidth
                disabled={busy !== null}
                onPress={openPhone}
              />

              {error ? (
                <Animated.View entering={reduceMotion ? undefined : FadeInDown.duration(200)} style={{ marginTop: space.base }}>
                  <Text variant="bodySmall" color="negative" accessibilityLiveRegion="polite">
                    {error}
                  </Text>
                </Animated.View>
              ) : null}

              <Text
                variant="caption"
                color="tertiaryText"
                align="center"
                style={{ maxWidth: space.hero * 6, alignSelf: 'center', marginTop: space.section }}
              >
                By continuing you agree to our Terms of Service and Privacy Policy.
              </Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Divider() {
  const { c, space } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.base,
        marginVertical: space.comfy,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
      <Text variant="caption" color="tertiaryText">
        or
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
    </View>
  );
}
