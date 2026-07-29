/**
 * The whole of signup.
 *
 * v1 asked for full name, username, email, phone, password and confirm password
 * — six fields and a keyboard, before the user had seen a single thing the app
 * does. This asks for one tap, or one phone number.
 *
 * There is no separate login screen any more, because passwordless auth makes
 * the distinction meaningless: the same Google tap and the same phone number
 * either find an existing account or create one, and the server decides which.
 * Presenting "Sign up" and "Sign in" as different doors would just make people
 * pick the wrong one.
 *
 * Name, email and everything else either arrive free with the OIDC token or are
 * never needed. KYC comes later, at withdrawal — see ARCHITECTURE.md §10.3.
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
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useTheme } from '@/design';
import { Button, Input, Text } from '@/components/ui';
import { useAuthStore } from '@/store/authStore';
import { saveUser, setToken as persistToken, TOKEN_KEY } from '@/services/tokenStorage';
import { AuthError, normalizePhone, requestOtp, signInWithIdToken } from '@/services/authV2';
import { isProviderAvailable, signInWithApple, signInWithGoogle } from '@/services/oauthProviders';

export default function AuthScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const { setUser, setToken } = useAuthStore();

  const [phone, setPhone] = useState('');
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

        // The user backed out of the system sheet — not an error worth shouting about.
        if (!result) return;

        const session = await signInWithIdToken(provider, result.idToken, result.fullName);
        await persistToken(TOKEN_KEY, session.token);
        setToken(session.token);
        setUser(session.user);
        await saveUser(session.user);

        // Branch rather than a ternary: a union of hrefs doesn't satisfy
        // expo-router's Href type, which resolves per literal.
        if (session.isNewAccount) router.replace('/set-pin');
        else router.replace('/(tabs)/(main)');
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
        // The v2 API does not exist yet. In development, walk on to the OTP
        // screen anyway so the flow can be reviewed end to end.
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
          {router.canGoBack() ? (
            <Pressable
              onPress={() => router.back()}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              style={{ height: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
            >
              <Ionicons name="arrow-back" size={24} color={c.primaryText} />
            </Pressable>
          ) : (
            <View style={{ height: 44 }} />
          )}

          <Animated.View entering={FadeInDown.duration(320)} style={{ marginTop: space.major }}>
            <Text variant="title">Get started</Text>
            <Text variant="body" color="secondaryText" style={{ marginTop: space.snug }}>
              Sign in or create an account — it&apos;s the same tap. No password to
              remember.
            </Text>
          </Animated.View>

          <View style={{ gap: space.base, marginTop: space.major }}>
            <Button
              title="Continue with Google"
              icon="logo-google"
              variant="secondary"
              size="lg"
              fullWidth
              loading={busy === 'google'}
              disabled={busy !== null}
              onPress={() => onSocial('google')}
            />

            {/* App Store Guideline 4.8: offering Google without a private
                alternative gets the build rejected. Apple-only on iOS, since
                Android has no Sign in with Apple. */}
            {Platform.OS === 'ios' && isProviderAvailable('apple') ? (
              <Button
                title="Continue with Apple"
                icon="logo-apple"
                variant="secondary"
                size="lg"
                fullWidth
                loading={busy === 'apple'}
                disabled={busy !== null}
                onPress={() => onSocial('apple')}
              />
            ) : null}
          </View>

          <Divider />

          <View style={{ gap: space.base }}>
            <Input
              label="Phone number"
              prefix="+234"
              placeholder="801 234 5678"
              value={phone}
              onChangeText={(t) => {
                setPhone(t);
                setError(null);
              }}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              returnKeyType="go"
              onSubmitEditing={phoneIsValid ? onPhone : undefined}
              maxLength={14}
              hint="We'll text you a 6-digit code."
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
          </View>

          {error ? (
            <Animated.View entering={FadeInDown.duration(200)} style={{ marginTop: space.base }}>
              <Text variant="bodySmall" color="negative">
                {error}
              </Text>
            </Animated.View>
          ) : null}

          <View style={{ flex: 1, minHeight: space.major }} />

          <Text
            variant="caption"
            color="tertiaryText"
            style={{ textAlign: 'center', maxWidth: 320, alignSelf: 'center' }}
          >
            By continuing you agree to our Terms of Service and Privacy Policy.
          </Text>
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
        marginVertical: space.major,
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
