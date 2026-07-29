/**
 * Skeleton with a travelling sheen.
 *
 * The previous placeholders were static grey blocks, which are indistinguishable
 * from a broken layout. Movement is what tells someone the app is working, so
 * the sheen matters more than the shape does.
 *
 * Respects reduced-motion: the sheen stops and the block simply holds, since
 * the whole point of that setting is that repeating animation is unpleasant for
 * some people.
 */

import { useEffect, useState } from 'react';
import { AccessibilityInfo, View, type DimensionValue, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@/design';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}

export function Skeleton({ width = '100%', height = 12, radius = 6, style }: SkeletonProps) {
  const { c, isDark } = useTheme();
  const progress = useSharedValue(-1);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setReduceMotion)
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub?.remove();
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(progress);
      progress.value = -1;
      return;
    }
    progress.value = -1;
    progress.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
      -1,
      false
    );
    return () => cancelAnimation(progress);
  }, [reduceMotion, progress]);

  const sheen = useAnimatedStyle(() => ({
    transform: [{ translateX: `${progress.value * 100}%` }],
  }));

  const sheenColor = isDark ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.045)';

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      style={[
        { width, height, borderRadius: radius, backgroundColor: c.surfaceElevated, overflow: 'hidden' },
        style,
      ]}
    >
      {!reduceMotion && (
        <Animated.View style={[{ width: '100%', height: '100%' }, sheen]}>
          <LinearGradient
            colors={['transparent', sheenColor, 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      )}
    </View>
  );
}

export default Skeleton;
