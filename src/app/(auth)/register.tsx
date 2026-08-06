/**
 * The shared entry for signup and signin.
 *
 * One field takes either a phone number or an email address, and the app works
 * out which. That is the whole screen — there is no provider choice to make, no
 * OAuth sheet, and no branching path to explain, so nothing sits between opening
 * the app and receiving a code.
 *
 * The keyboard and hint adapt as you type: digits get the phone pad and a "we'll
 * text you" hint, an `@` switches to the email keyboard mid-entry. The
 * discriminator is `@` and it is checked before anything else, because a string
 * containing one is never a phone number — treating `0801…@gmail.com` as a phone
 * would send an SMS into the void.
 */

import { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { useTheme } from '@/design';
import { Button, Input, Text } from '@/components/ui';
import { CryptoLogoMarquee } from '@/components/auth/CryptoLogoMarquee';
import { LightAuthScreen } from '@/components/auth/LightAuthScreen';
import { AuthError, parseIdentifier, requestOtp } from '@/services/authV2';

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

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identifier = useMemo(() => parseIdentifier(input), [input]);

  // What the user is *evidently* typing, which is not the same as what parses.
  // "ada@" looks like an email long before it is a valid one, and the keyboard
  // must not flip back to digits while they are still typing the domain.
  const looksLikeEmail = input.includes('@');

  const onSubmit = useCallback(async () => {
    if (!identifier) return;
    setError(null);
    setBusy(true);
    try {
      const sent = await requestOtp(input);
      router.push({
        pathname: '/verify',
        params: { identifier: sent.value, kind: sent.kind },
      });
    } catch (err) {
      if (err instanceof AuthError && err.offline && __DEV__) {
        // The v2 API is not serving yet. In development, walk on so the flow can
        // be reviewed end to end.
        router.push({
          pathname: '/verify',
          params: { identifier: identifier.value, kind: identifier.kind, mock: '1' },
        });
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not send code');
    } finally {
      setBusy(false);
    }
  }, [identifier, input, router]);

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={{ flex: 1, backgroundColor: c.primaryBackground }}
    >
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

          <Animated.View
            entering={reduceMotion ? undefined : FadeInDown.duration(240)}
            style={{ gap: space.comfy, marginTop: space.section }}
          >
            <Input
              label="Phone number or email"
              placeholder="0801 234 5678"
              value={input}
              onChangeText={(text) => {
                setInput(text);
                setError(null);
              }}
              // Switches as soon as an "@" appears, so the user is never stuck on
              // a number pad halfway through typing an address.
              keyboardType={looksLikeEmail ? 'email-address' : 'phone-pad'}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete={looksLikeEmail ? 'email' : 'tel'}
              textContentType={looksLikeEmail ? 'emailAddress' : 'telephoneNumber'}
              returnKeyType="go"
              onSubmitEditing={identifier ? onSubmit : undefined}
              hint={
                looksLikeEmail
                  ? "We'll email you a 6 digit code."
                  : "We'll text you a 6 digit code."
              }
              accessibilityLabel="Phone number or email address"
            />

            <Button
              title="Continue"
              size="lg"
              fullWidth
              iconRight="arrow-forward"
              loading={busy}
              disabled={!identifier || busy}
              onPress={onSubmit}
            />

            {error ? (
              <Animated.View entering={reduceMotion ? undefined : FadeInDown.duration(200)}>
                <Text variant="bodySmall" color="negative" accessibilityLiveRegion="polite">
                  {error}
                </Text>
              </Animated.View>
            ) : null}
          </Animated.View>

          <View style={{ flex: 1, minHeight: space.section }} />

          <Text
            variant="caption"
            color="tertiaryText"
            align="center"
            style={{ maxWidth: space.hero * 6, alignSelf: 'center' }}
          >
            By continuing you agree to our Terms of Service and Privacy Policy.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
