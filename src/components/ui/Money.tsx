/**
 * Money.
 *
 * Every monetary figure in the app renders through this. It exists to make one
 * treatment consistent everywhere:
 *
 *   ₦  1,240,500 .00
 *   ↑  ↑          ↑
 *   │  │          └─ fraction, de-emphasised — precision without noise
 *   │  └─ integer, full weight — this is what the eye should land on
 *   └─ symbol, smaller and dimmer — context, not content
 *
 * A balance is one number a person reads under mild stress. Splitting the
 * registers means they read the magnitude first and the cents only if they
 * care, instead of scanning a uniform wall of digits.
 *
 * With `live`, a change in value plays a small ticker movement and tints
 * briefly toward the direction it moved. That is reserved for figures that
 * genuinely move on their own — the exchange rate — and never used for a
 * static balance, where motion would imply something changed when it didn't.
 */

import { useEffect, useRef } from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  interpolateColor,
} from 'react-native-reanimated';
import { useTheme } from '@/design';
import { type as typeScale } from '@/design/typography';
import { tabular } from '@/design/typography';
import type { Colors } from '@/constants/colors';

type MoneyVariant = 'display' | 'figure' | 'amount' | 'amountSmall';

export interface MoneyProps {
  /** The numeric value. Pass a number, not a pre-formatted string. */
  value: number | null | undefined;
  currency?: 'NGN' | 'USD' | 'none';
  /** Asset ticker rendered after the figure, e.g. "USDT". */
  suffix?: string;
  variant?: MoneyVariant;
  color?: keyof Colors | string;
  /** Hide the fraction entirely. Use for whole-naira rates. */
  whole?: boolean;
  /** Crypto amounts need more precision than money does. */
  maxFractionDigits?: number;
  /** Show a +/− sign. `auto` signs only negatives. */
  sign?: 'auto' | 'always' | 'never';
  /** Animate on change. Only for self-updating figures. */
  live?: boolean;
  /** Rendered while value is null/undefined. */
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
  numberStyle?: StyleProp<TextStyle>;
}

const SYMBOL: Record<string, string> = { NGN: '₦', USD: '$', none: '' };

/** Symbol and fraction sit at a fixed ratio of the integer size. */
const SYMBOL_RATIO = 0.56;
const FRACTION_RATIO = 0.52;

function splitAmount(
  value: number,
  whole: boolean,
  maxFractionDigits: number
): { int: string; frac: string | null } {
  const abs = Math.abs(value);
  if (whole) {
    return { int: Math.round(abs).toLocaleString('en-NG'), frac: null };
  }
  const fixed = abs.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFractionDigits,
  });
  const sep = fixed.lastIndexOf('.');
  if (sep === -1) return { int: fixed, frac: null };
  return { int: fixed.slice(0, sep), frac: fixed.slice(sep) };
}

export function Money({
  value,
  currency = 'NGN',
  suffix,
  variant = 'amount',
  color = 'primaryText',
  whole = false,
  maxFractionDigits = 2,
  sign = 'auto',
  live = false,
  placeholder = '—',
  style,
  numberStyle,
}: MoneyProps) {
  const { c, motion } = useTheme();
  const base = typeScale[variant];
  const resolved = color in c ? c[color as keyof Colors] : (color as string);

  const shift = useSharedValue(0);
  const tint = useSharedValue(0);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    if (!live || value == null) return;
    const prev = previous.current;
    previous.current = value;
    if (prev == null || prev === value) return;

    const rose = value > prev;
    // Nudge from the direction the value came from, then spring home.
    shift.value = rose ? 7 : -7;
    shift.value = withSpring(0, motion.settle);
    tint.value = rose ? 1 : -1;
    tint.value = withSequence(
      withTiming(rose ? 1 : -1, { duration: motion.duration.instant }),
      withTiming(0, { duration: motion.duration.slow })
    );
  }, [value, live, motion, shift, tint]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: shift.value }],
  }));

  const animatedColor = useAnimatedStyle(() => ({
    color: interpolateColor(tint.value, [-1, 0, 1], [c.negative, resolved, c.positive]),
  }));

  if (value == null || !Number.isFinite(value)) {
    return (
      <Animated.Text
        style={[base, tabular, { color: c.tertiaryText }, numberStyle]}
        accessibilityLabel="Not available"
      >
        {placeholder}
      </Animated.Text>
    );
  }

  const { int, frac } = splitAmount(value, whole, maxFractionDigits);
  const symbol = SYMBOL[currency] ?? '';
  const prefix =
    sign === 'never' ? '' : value < 0 ? '−' : sign === 'always' && value > 0 ? '+' : '';

  const symbolSize = Math.round(base.fontSize * SYMBOL_RATIO);
  const fractionSize = Math.round(base.fontSize * FRACTION_RATIO);

  // A single accessible string — screen readers should hear one figure, not
  // four fragments in different sizes.
  const label = `${prefix}${symbol}${int}${frac ?? ''}${suffix ? ` ${suffix}` : ''}`;

  return (
    <View
      style={[{ flexDirection: 'row', alignItems: 'baseline' }, style]}
      accessible
      accessibilityLabel={label}
    >
      {/* Siblings, not nested Texts.

          Nesting a smaller Text inside a larger one is the obvious way to build
          "₦1,240,500.00" with three weights, and it renders correctly right up
          until the parent also has to shrink to fit — at which point iOS lays
          the child out against the parent's original size and the symbol
          collides with the first digit. Laying them out as siblings on a shared
          baseline gives the same result with no interaction between the two. */}
      {prefix ? (
        <Animated.Text
          style={[base, tabular, animatedColor, animatedStyle, numberStyle]}
          allowFontScaling={false}
        >
          {prefix}
        </Animated.Text>
      ) : null}

      {symbol ? (
        <Animated.Text
          style={[
            base,
            tabular,
            animatedStyle,
            {
              fontSize: symbolSize,
              lineHeight: base.lineHeight,
              color: c.secondaryText,
              // The display sizes carry negative tracking, which is right for a
              // run of digits and wrong on a lone symbol: applied after the
              // glyph it drags the next element back over it, which is what put
              // the ₦ through the middle of the 0. Neutralised, with an explicit
              // gap so the spacing is a decision rather than a leftover.
              letterSpacing: 0,
              marginRight: Math.max(2, Math.round(base.fontSize * 0.06)),
            },
          ]}
          allowFontScaling={false}
        >
          {symbol}
        </Animated.Text>
      ) : null}

      <Animated.Text
        style={[base, tabular, animatedColor, animatedStyle, numberStyle]}
        allowFontScaling={false}
        numberOfLines={1}
        // Deliberately not `adjustsFontSizeToFit`. Inside a baseline-aligned row
        // it shrinks the glyph without telling the row, so neighbours lay out
        // against the original width and end up overlapping. A long balance
        // truncating is a worse-looking edge case than every balance being
        // wrong, so the row wraps instead — see the container's flexWrap.
      >
        {int}
      </Animated.Text>

      {frac ? (
        <Animated.Text
          style={[
            base,
            tabular,
            animatedStyle,
            {
              fontSize: fractionSize,
              lineHeight: base.lineHeight,
              color: c.secondaryText,
              letterSpacing: 0,
            },
          ]}
          allowFontScaling={false}
        >
          {frac}
        </Animated.Text>
      ) : null}
      {suffix ? (
        <Animated.Text
          style={{
            fontFamily: typeScale.amountSmall.fontFamily,
            fontSize: Math.max(11, Math.round(base.fontSize * 0.42)),
            color: c.secondaryText,
            marginLeft: 5,
          }}
        >
          {suffix}
        </Animated.Text>
      ) : null}
    </View>
  );
}

export default Money;
