/**
 * Input.
 *
 * Also fixes the static-palette bug — the old version read the dark constants
 * directly, so fields stayed dark in light mode.
 *
 * The focus ring animates the border colour rather than snapping it, because a
 * field is the one place where the user needs unambiguous feedback about where
 * their keystrokes are going.
 *
 * Error text replaces the helper text in place rather than appearing below it,
 * so the field never changes height and the form doesn't jump as someone types.
 */

import { forwardRef, useCallback, useState } from 'react';
import {
  Pressable,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Text } from './Text';

export interface InputProps extends TextInputProps {
  label?: string;
  /** Guidance shown under the field when there's no error. */
  hint?: string;
  error?: string;
  /** Ionicon rendered inside the field, leading. */
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  /** Static text inside the field, e.g. "₦" or "+234". */
  prefix?: string;
  /** Tappable element at the trailing edge, e.g. a Max button. */
  trailing?: React.ReactNode;
  /** Use the mono face — for addresses, amounts, references. */
  mono?: boolean;
  containerStyle?: ViewStyle;
  /** Override field corner radius. Defaults to the field token. */
  shellRadius?: number;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    hint,
    error,
    icon,
    prefix,
    trailing,
    mono = false,
    containerStyle,
    shellRadius,
    onFocus,
    onBlur,
    editable = true,
    style,
    ...props
  },
  ref
) {
  const { c, iconSize, radius, space, type, motion, minTouch } = useTheme();
  const [focused, setFocused] = useState(false);
  const focus = useSharedValue(0);

  const handleFocus = useCallback(
    (e: Parameters<NonNullable<TextInputProps['onFocus']>>[0]) => {
      setFocused(true);
      focus.value = withTiming(1, { duration: motion.duration.fast });
      onFocus?.(e);
    },
    [focus, motion, onFocus]
  );

  const handleBlur = useCallback(
    (e: Parameters<NonNullable<TextInputProps['onBlur']>>[0]) => {
      setFocused(false);
      focus.value = withTiming(0, { duration: motion.duration.fast });
      onBlur?.(e);
    },
    [focus, motion, onBlur]
  );

  const shellStyle = useAnimatedStyle(() => ({
    borderColor: error
      ? c.negative
      : interpolateColor(focus.value, [0, 1], [c.border, c.primaryAccent]),
  }));

  return (
    <View style={[{ marginBottom: space.comfy }, containerStyle]}>
      {label ? (
        <Text variant="label" color="secondaryText" style={{ marginBottom: space.snug }}>
          {label}
        </Text>
      ) : null}

      <Animated.View
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.snug,
            minHeight: minTouch + 4,
            backgroundColor: c.surfaceInput,
            borderWidth: 1,
            borderRadius: shellRadius ?? radius.field,
            paddingHorizontal: space.comfy,
            opacity: editable ? 1 : 0.55,
          },
          shellStyle,
        ]}
      >
        {icon ? (
          <Ionicons
            name={icon}
            size={iconSize.medium}
            color={focused ? c.primaryAccent : c.tertiaryText}
          />
        ) : null}

        {prefix ? (
          <Text variant={mono ? 'amount' : 'body'} color="secondaryText">
            {prefix}
          </Text>
        ) : null}

        <TextInput
          ref={ref}
          editable={editable}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholderTextColor={c.quaternaryText}
          selectionColor={c.primaryAccent}
          cursorColor={c.primaryAccent}
          style={[
            {
              flex: 1,
              paddingVertical: 14,
              color: c.primaryText,
              ...(mono ? type.amount : type.body),
            },
            style,
          ]}
          {...props}
        />

        {trailing}
      </Animated.View>

      {error ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.tight, marginTop: space.tight }}
        >
          <Ionicons name="alert-circle" size={iconSize.small} color={c.negative} />
          <Text variant="caption" color="negative">
            {error}
          </Text>
        </View>
      ) : hint ? (
        <Text variant="caption" color="tertiaryText" style={{ marginTop: space.tight }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

/** A small inline action for the trailing slot, e.g. "Max" or "Paste". */
export function FieldAction({ label, onPress }: { label: string; onPress: () => void }) {
  const { c, radius, hitSlop, space } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlop}
      style={{
        backgroundColor: c.accentDim,
        borderRadius: radius.chip,
        paddingHorizontal: space.base,
        paddingVertical: space.tight,
      }}
    >
      <Text variant="eyebrow" color="primaryAccent">
        {label}
      </Text>
    </Pressable>
  );
}

export default Input;
