/**
 * OTP entry.
 *
 * The six boxes are presentation only — behind them sits one real TextInput
 * carrying `textContentType="oneTimeCode"` and `autoComplete="sms-otp"`, so iOS
 * and Android can fill the code straight from the SMS. Six separate inputs, the
 * usual approach, break that autofill entirely and force the user to type a code
 * their phone already knows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/design';
import { Button, Text } from '@/components/ui';
import { useAuthStore } from '@/store/authStore';
import { saveUser, setToken as persistToken, TOKEN_KEY } from '@/services/tokenStorage';
import { AuthError, requestOtp, verifyOtp } from '@/services/authV2';

const CODE_LENGTH = 6;
const RESEND_SECONDS = 60;

export default function VerifyScreen() {
  const router = useRouter();
  const { c, space, radius } = useTheme();
  const { setUser, setToken } = useAuthStore();
  const params = useLocalSearchParams<{ phone: string; mock?: string }>();
  const phone = params.phone ?? '';
  const isMock = params.mock === '1';

  const inputRef = useRef<TextInput>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);

  const shake = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));

  useEffect(() => {
    const t = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);

  // Focus on mount so the keyboard (and the autofill bar) is up immediately.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 350);
    return () => clearTimeout(t);
  }, []);

  const submit = useCallback(
    async (submitted: string) => {
      setBusy(true);
      setError(null);
      try {
        const session = await verifyOtp(phone, submitted);
        await persistToken(TOKEN_KEY, session.token);
        setToken(session.token);
        setUser(session.user);
        await saveUser(session.user);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (session.isNewAccount) router.replace('/set-pin');
        else router.replace('/(tabs)/(main)');
      } catch (err) {
        if (err instanceof AuthError && err.offline && __DEV__ && isMock) {
          // No v2 API yet. The seeded dev code walks the flow onward.
          if (submitted === '000000') {
            router.replace('/set-pin');
            return;
          }
          setError('Dev mode: use 000000');
        } else {
          setError(err instanceof Error ? err.message : 'Could not verify code');
        }
        shake.value = withSequence(
          withTiming(-8, { duration: 50 }),
          withTiming(8, { duration: 50 }),
          withTiming(-6, { duration: 50 }),
          withTiming(0, { duration: 50 }),
        );
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setCode('');
      } finally {
        setBusy(false);
      }
    },
    [phone, router, setToken, setUser, shake, isMock],
  );

  const onChange = useCallback(
    (text: string) => {
      const digits = text.replace(/\D/g, '').slice(0, CODE_LENGTH);
      setCode(digits);
      setError(null);
      if (digits.length === CODE_LENGTH) void submit(digits);
    },
    [submit],
  );

  const resend = useCallback(async () => {
    try {
      await requestOtp(phone);
      setSecondsLeft(RESEND_SECONDS);
      setCode('');
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
      if (err instanceof AuthError && err.offline && __DEV__) {
        setSecondsLeft(RESEND_SECONDS);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not resend');
    }
  }, [phone]);

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.primaryBackground }}>
      <View style={{ flex: 1, paddingHorizontal: space.roomy }}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={{ height: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
        >
          <Ionicons name="arrow-back" size={24} color={c.primaryText} />
        </Pressable>

        <Animated.View entering={FadeIn.duration(300)} style={{ marginTop: space.major }}>
          <Text variant="title">Enter your code</Text>
          <Text variant="body" color="secondaryText" style={{ marginTop: space.snug }}>
            Sent to {formatPhone(phone)}
          </Text>
        </Animated.View>

        <Pressable onPress={() => inputRef.current?.focus()} accessibilityRole="button">
          <Animated.View
            style={[
              { flexDirection: 'row', gap: space.snug, marginTop: space.major },
              shakeStyle,
            ]}
          >
            {Array.from({ length: CODE_LENGTH }).map((_, i) => {
              const filled = i < code.length;
              const isCursor = i === code.length;
              return (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    aspectRatio: 0.78,
                    borderRadius: radius.field,
                    borderWidth: 1,
                    borderColor: error
                      ? c.negative
                      : isCursor
                        ? c.primaryAccent
                        : c.border,
                    backgroundColor: c.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text variant="figure" color={filled ? 'primaryText' : 'tertiaryText'}>
                    {filled ? code[i] : ''}
                  </Text>
                </View>
              );
            })}
          </Animated.View>
        </Pressable>

        {/* The real field. Invisible, but present in the tree so the OS can
            autofill it — `display: none` would remove it from autofill too. */}
        <TextInput
          ref={inputRef}
          value={code}
          onChangeText={onChange}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
          maxLength={CODE_LENGTH}
          editable={!busy}
          caretHidden
          style={{
            position: 'absolute',
            opacity: 0,
            height: 1,
            width: 1,
          }}
        />

        {error ? (
          <Text variant="bodySmall" color="negative" style={{ marginTop: space.base }}>
            {error}
          </Text>
        ) : null}

        {__DEV__ && isMock ? (
          <Text variant="caption" color="tertiaryText" style={{ marginTop: space.base }}>
            Dev build, no API yet — the seeded code is 000000.
          </Text>
        ) : null}

        <View style={{ marginTop: space.major, alignItems: 'center' }}>
          {secondsLeft > 0 ? (
            <Text variant="bodySmall" color="tertiaryText">
              Resend code in {secondsLeft}s
            </Text>
          ) : (
            <Button title="Resend code" variant="ghost" onPress={resend} />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

/** +2348012345678 → +234 801 234 5678 */
function formatPhone(e164: string): string {
  const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+234 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
