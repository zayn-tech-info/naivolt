/**
 * PinPad — 6-digit PIN entry.
 *
 * v2 gates withdrawals and bank-account changes behind a PIN (ARCHITECTURE.md
 * §10), so this is on the path of every payout.
 *
 * It ships its own keypad rather than using the system keyboard, for three
 * reasons: the digits stay put instead of the layout jumping when the keyboard
 * animates in, nothing is typed into a field that could be autofilled or
 * screenshotted with the value visible, and a wrong PIN can shake in place
 * without the keyboard covering the feedback.
 *
 * A wrong entry shakes and clears. That's a deliberate borrow from the OS lock
 * screen: it's the interaction people already know means "wrong, try again",
 * so it needs no explanation.
 */

import { useCallback, useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { motion as motionTokens } from '@/design/tokens';
import { Text } from './Text';

export interface PinPadProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  /** Set true to shake and clear — for a rejected PIN. */
  error?: boolean;
  onErrorShown?: () => void;
  /** Called once the final digit lands. */
  onComplete?: (value: string) => void;
  /** Offer biometric unlock alongside the keypad. */
  onBiometric?: () => void;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

function Dot({ filled, error }: { filled: boolean; error: boolean }) {
  const { c, radius } = useTheme();
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(filled ? 1 : 0.7);

  useEffect(() => {
    scale.value = reduceMotion ? 1 : withSpring(filled ? 1 : 0.7, motionTokens.settle);
  }, [filled, reduceMotion, scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View
      style={[
        {
          width: 13,
          height: 13,
          borderRadius: radius.chip,
          backgroundColor: error ? c.negative : filled ? c.primaryText : 'transparent',
          borderWidth: filled && !error ? 0 : 1.5,
          borderColor: error ? c.negative : c.borderLight,
        },
        style,
      ]}
    />
  );
}

function Key({
  label,
  icon,
  onPress,
  muted = false,
  disabled = false,
}: {
  label?: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  muted?: boolean;
  disabled?: boolean;
}) {
  const { c, radius } = useTheme();
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={[{ flex: 1 }, style]}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        onPressIn={() => {
          scale.value = reduceMotion ? 1 : withSpring(0.94, motionTokens.press);
        }}
        onPressOut={() => {
          scale.value = withSpring(1, motionTokens.press);
        }}
        accessibilityRole="button"
        accessibilityLabel={label ?? String(icon)}
        style={{
          minHeight: 58,
          borderRadius: radius.control,
          backgroundColor: muted ? 'transparent' : c.surface,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.3 : 1,
        }}
      >
        {label ? (
          <Text variant="heading">
            {label}
          </Text>
        ) : (
          <Ionicons name={icon!} size={22} color={c.secondaryText} />
        )}
      </Pressable>
    </Animated.View>
  );
}

export function PinPad({
  value,
  onChange,
  length = 6,
  error = false,
  onErrorShown,
  onComplete,
  onBiometric,
}: PinPadProps) {
  const { space, minTouch } = useTheme();
  const reduceMotion = useReducedMotion();
  const shake = useSharedValue(0);

  useEffect(() => {
    if (!error) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    shake.value = reduceMotion
      ? 0
      : withSequence(
          withTiming(-9, { duration: 55 }),
          withTiming(9, { duration: 55 }),
          withTiming(-6, { duration: 55 }),
          withTiming(0, { duration: 55 })
        );
    const id = setTimeout(() => {
      onChange('');
      onErrorShown?.();
    }, 260);
    return () => clearTimeout(id);
  }, [error, reduceMotion, shake, onChange, onErrorShown]);

  const press = useCallback(
    (digit: string) => {
      if (value.length >= length) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const next = value + digit;
      onChange(next);
      if (next.length === length) onComplete?.(next);
    },
    [value, length, onChange, onComplete]
  );

  const backspace = useCallback(() => {
    if (!value.length) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onChange(value.slice(0, -1));
  }, [value, onChange]);

  const dotsStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shake.value }],
  }));

  return (
    <View style={{ alignItems: 'center', gap: space.major }}>
      <Animated.View
        style={[{ flexDirection: 'row', gap: space.base }, dotsStyle]}
        accessibilityLabel={`${value.length} of ${length} digits entered`}
      >
        {Array.from({ length }).map((_, i) => (
          <Dot key={i} filled={i < value.length} error={error} />
        ))}
      </Animated.View>

      <View style={{ gap: space.base, width: '100%', maxWidth: 300 }}>
        {[KEYS.slice(0, 3), KEYS.slice(3, 6), KEYS.slice(6, 9)].map((row, ri) => (
          <View key={ri} style={{ flexDirection: 'row', gap: space.base }}>
            {row.map((k) => (
              <Key key={k} label={k} onPress={() => press(k)} />
            ))}
          </View>
        ))}

        <View style={{ flexDirection: 'row', gap: space.base }}>
          {onBiometric ? (
            <Key icon="finger-print-outline" onPress={onBiometric} muted />
          ) : (
            <View style={{ flex: 1, minHeight: minTouch }} />
          )}
          <Key label="0" onPress={() => press('0')} />
          <Key icon="backspace-outline" onPress={backspace} muted disabled={value.length === 0} />
        </View>
      </View>
    </View>
  );
}

export default PinPad;
