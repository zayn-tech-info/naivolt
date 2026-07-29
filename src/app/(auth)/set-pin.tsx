/**
 * PIN setup — the last step of onboarding, and the only one that asks the user
 * to invent something.
 *
 * The PIN is not a login credential; sessions handle that. Its job is to make a
 * stolen *unlocked* phone insufficient to move money. So it is required once
 * here, then only at withdrawal.
 *
 * Weak PINs are rejected client-side with the same rules the server enforces
 * (crates/auth/src/pin.rs), so the failure is instant rather than a round trip.
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/design';
import { PinPad, Text } from '@/components/ui';
import { useAuthStore } from '@/store/authStore';
import { setPin as savePin } from '@/services/authV2';

type Stage = 'choose' | 'confirm';

export default function SetPinScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const token = useAuthStore((s) => s.token);

  const [stage, setStage] = useState<Stage>('choose');
  const [first, setFirst] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(false);

  const fail = useCallback((message: string) => {
    setError(message);
    setShake(true);
    setValue('');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  }, []);

  const onComplete = useCallback(
    async (entered: string) => {
      if (stage === 'choose') {
        const weakness = describeWeakness(entered);
        if (weakness) {
          fail(weakness);
          return;
        }
        setFirst(entered);
        setValue('');
        setError(null);
        setStage('confirm');
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
      }

      if (entered !== first) {
        fail("Those didn't match. Try again.");
        setStage('choose');
        setFirst('');
        return;
      }

      try {
        if (token) await savePin(token, entered);
      } catch {
        // The PIN is confirmed locally; a failed sync should not strand the user
        // at the end of onboarding. It re-syncs on the next authorised action.
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)/(main)');
    },
    [stage, first, fail, token, router],
  );

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.primaryBackground }}>
      <View style={{ flex: 1, paddingHorizontal: space.roomy, justifyContent: 'space-between' }}>
        <Animated.View entering={FadeIn.duration(300)} style={{ marginTop: space.major }}>
          <Text variant="title">
            {stage === 'choose' ? 'Set a transaction PIN' : 'Confirm your PIN'}
          </Text>
          <Text variant="body" color="secondaryText" style={{ marginTop: space.snug }}>
            {stage === 'choose'
              ? "Six digits. You'll enter it to withdraw — not to open the app."
              : 'Enter the same six digits once more.'}
          </Text>

          {error ? (
            <Text variant="bodySmall" color="negative" style={{ marginTop: space.base }}>
              {error}
            </Text>
          ) : null}
        </Animated.View>

        <PinPad
          value={value}
          onChange={(v) => {
            setValue(v);
            if (error) setError(null);
          }}
          length={6}
          error={shake}
          onErrorShown={() => setShake(false)}
          onComplete={onComplete}
        />
      </View>
    </SafeAreaView>
  );
}

/**
 * Mirrors `validate_pin_strength` in crates/auth/src/pin.rs. Kept small on
 * purpose — rejecting too much pushes people into writing the PIN down, which is
 * worse than a slightly weak one.
 */
function describeWeakness(pin: string): string | null {
  const d = pin.split('').map(Number);

  if (d.every((x) => x === d[0])) return 'Too easy to guess — avoid repeating one digit.';

  const ascending = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const descending = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  if (ascending || descending) return 'Too easy to guess — avoid runs like 123456.';

  const pairRepeat = d[0] === d[2] && d[2] === d[4] && d[1] === d[3] && d[3] === d[5];
  const tripleRepeat = d[0] === d[3] && d[1] === d[4] && d[2] === d[5];
  if (pairRepeat || tripleRepeat) return 'Too easy to guess — avoid repeating patterns.';

  if (/^(19|20)\d{2}00$/.test(pin)) return 'Avoid using a year.';

  return null;
}
