/**
 * QuoteTimer — locked-rate countdown.
 *
 * NOTE: currently unreferenced. It was built for the crypto Sell flow, which was
 * removed in favour of gift cards. Kept because quotes remain core to the backend
 * design (ARCHITECTURE.md §9) and this is the component that renders one; delete
 * it if crypto selling is off the roadmap for good rather than deferred.
 *
 * When someone locks a rate, the backend issues a quote valid for 60 seconds
 * (ARCHITECTURE.md §9). That expiry is the most consequential thing on screen:
 * the price is guaranteed until it runs out, and then it isn't.
 *
 * So it gets rendered as a physically depleting object rather than a number
 * counting down. A bar that visibly drains reads as "this is running out" pre-
 * attentively, before the digits are even parsed. The digits stay too, in mono,
 * because at five seconds left the exact figure matters.
 *
 * The colour crosses from lime to amber to red as it drains, which is the one
 * place lime is allowed to signal state — because here the state *is* the
 * actionability of the button beside it.
 *
 * Drives itself off wall-clock `expiresAt` rather than counting frames, so
 * backgrounding the app and returning doesn't leave a stale timer showing time
 * the user doesn't actually have.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { useTheme } from '@/design';
import Text from './Text';

export interface QuoteTimerProps {
  /** ISO timestamp or epoch ms when the quote expires. */
  expiresAt: string | number;
  /** Total validity window in seconds, used to scale the bar. */
  windowSeconds?: number;
  onExpire?: () => void;
  label?: string;
}

function remainingMs(expiresAt: string | number): number {
  const end = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  return Math.max(0, end - Date.now());
}

export function QuoteTimer({
  expiresAt,
  windowSeconds = 60,
  onExpire,
  label = 'Rate locked',
}: QuoteTimerProps) {
  const { c, space, radius, motion } = useTheme();
  const [left, setLeft] = useState(() => remainingMs(expiresAt));
  const fill = useSharedValue(1);
  const fired = useRef(false);

  const sync = useCallback(() => {
    const ms = remainingMs(expiresAt);
    setLeft(ms);
    const ratio = Math.max(0, Math.min(1, ms / (windowSeconds * 1000)));
    // Animate to the true remaining fraction; linear, because a quote drains
    // at a constant rate and easing it would misrepresent the time left.
    fill.value = withTiming(ratio, { duration: 250, easing: Easing.linear });

    if (ms <= 0 && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
    return ms;
  }, [expiresAt, windowSeconds, fill, onExpire]);

  useEffect(() => {
    fired.current = false;
    sync();
    const id = setInterval(() => {
      if (sync() <= 0) clearInterval(id);
    }, 250);

    // Re-sync on foreground: the interval doesn't run reliably in background.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') sync();
    });

    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [sync]);

  const seconds = Math.ceil(left / 1000);
  const ratio = Math.max(0, Math.min(1, left / (windowSeconds * 1000)));

  // Three bands rather than a continuous gradient: the transition itself is the
  // signal, and a smooth blend would be invisible.
  const tone = ratio > 0.5 ? c.primaryAccent : ratio > 0.2 ? c.warning : c.negative;

  const barStyle = useAnimatedStyle(() => ({
    width: `${fill.value * 100}%`,
  }));

  const expired = left <= 0;

  return (
    <View style={{ gap: space.snug }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="eyebrow" color={expired ? 'negative' : 'tertiaryText'}>
          {expired ? 'Rate expired' : label}
        </Text>
        <Text variant="ticker" color={expired ? c.negative : tone}>
          {expired ? 'tap to refresh' : `${seconds}s`}
        </Text>
      </View>

      <View
        accessibilityRole="progressbar"
        accessibilityLabel={expired ? 'Rate expired' : `${seconds} seconds left on this rate`}
        style={{
          height: 3,
          borderRadius: radius.chip,
          backgroundColor: c.surfaceElevated,
          overflow: 'hidden',
        }}
      >
        <Animated.View
          style={[{ height: '100%', borderRadius: radius.chip, backgroundColor: tone }, barStyle]}
        />
      </View>
    </View>
  );
}

export default QuoteTimer;
