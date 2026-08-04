/**
 * Button.
 *
 * Replaces a version that imported the static dark palette directly, so it
 * rendered dark-theme colours even in light mode. It now reads the active
 * palette like everything else.
 *
 * Press feedback is a spring-driven scale rather than `activeOpacity`. Opacity
 * fade reads as "this element is becoming unavailable"; a scale reads as
 * "you pressed a physical thing", which is what we want on a button that
 * moves someone's money.
 */

import { useCallback } from 'react';
import { Pressable, ActivityIndicator, type ViewStyle, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  /** Ionicon name rendered before the label. */
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  iconRight?: React.ComponentProps<typeof Ionicons>['name'];
  /** Stretch to fill the parent's cross axis. */
  fullWidth?: boolean;
  /**
   * Haptic weight. Defaults to light; use `medium` for a committing action
   * (confirming a sell, authorising a payout).
   */
  haptic?: 'none' | 'light' | 'medium' | 'success';
  style?: ViewStyle;
  textStyle?: TextStyle;
  accessibilityHint?: string;
}

const SIZES: Record<ButtonSize, { height: number; padX: number; gap: number; icon: number }> = {
  sm: { height: 40, padX: 14, gap: 6, icon: 16 },
  md: { height: 52, padX: 20, gap: 8, icon: 18 },
  lg: { height: 58, padX: 24, gap: 10, icon: 20 },
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  iconRight,
  fullWidth = false,
  haptic = 'light',
  style,
  textStyle,
  accessibilityHint,
}: ButtonProps) {
  const { c, radius, motion, disabledOpacity } = useTheme();
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const inactive = disabled || loading;

  const dims = SIZES[size];

  const surface: Record<ButtonVariant, ViewStyle> = {
    primary: { backgroundColor: c.primaryAccent },
    secondary: { backgroundColor: c.surfaceElevated },
    ghost: { backgroundColor: 'transparent' },
    destructive: { backgroundColor: c.negativeDim },
  };

  const label: Record<ButtonVariant, string> = {
    primary: c.buttonTextOnAccent,
    secondary: c.primaryText,
    ghost: c.secondaryText,
    destructive: c.negative,
  };

  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePressIn = useCallback(() => {
    if (inactive) return;
    scale.value = reduceMotion ? 1 : withSpring(motion.pressScale, motion.press);
  }, [inactive, motion, reduceMotion, scale]);

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, motion.press);
  }, [motion, scale]);

  const handlePress = useCallback(() => {
    if (inactive) return;
    if (haptic !== 'none') {
      if (haptic === 'success') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } else {
        const style =
          haptic === 'medium'
            ? Haptics.ImpactFeedbackStyle.Medium
            : Haptics.ImpactFeedbackStyle.Light;
        Haptics.impactAsync(style).catch(() => {});
      }
    }
    onPress();
  }, [inactive, haptic, onPress]);

  return (
    <Animated.View style={[animated, fullWidth && { alignSelf: 'stretch' }, style]}>
      <Pressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={inactive}
        accessibilityRole="button"
        accessibilityState={{ disabled: inactive, busy: loading }}
        accessibilityLabel={title}
        accessibilityHint={accessibilityHint}
        style={[
          {
            height: dims.height,
            paddingHorizontal: dims.padX,
            borderRadius: radius.control,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: dims.gap,
          },
          surface[variant],
          inactive && { opacity: disabledOpacity },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={label[variant]} size="small" />
        ) : (
          <>
            {icon ? <Ionicons name={icon} size={dims.icon} color={label[variant]} /> : null}
            <Text
              variant="action"
              color={label[variant]}
              style={textStyle}
              numberOfLines={1}
            >
              {title}
            </Text>
            {iconRight ? <Ionicons name={iconRight} size={dims.icon} color={label[variant]} /> : null}
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

export default Button;
