/**
 * Surface — the card primitive.
 *
 * Depth comes from the surface's own lightness stepping up the elevation
 * ladder, not from wrapping everything in a 1px border. The previous design
 * gave every element `surface + border + radius:12`, which flattened the whole
 * app into one visual register. Borders here are opt-in and rare.
 */

import { useCallback } from 'react';
import { Pressable, View, type ViewProps, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/design';

export interface SurfaceProps extends ViewProps {
  /** 0 sits flush on the canvas; 1 is a resting card; 2 is raised; 3 floats. */
  level?: 0 | 1 | 2 | 3;
  /** Inner padding. Defaults to the comfortable card inset. */
  padding?: number;
  radiusToken?: keyof typeof import('@/design/tokens').radius;
  /** Adds a hairline. Use only where an edge carries meaning. */
  bordered?: boolean;
  /** A coloured left edge — reserved for advisories and warnings. */
  accentEdge?: string;
  onPress?: () => void;
  /** Shadow, for things that genuinely float above content. */
  shadow?: 0 | 1 | 2 | 3;
  haptic?: boolean;
  style?: ViewStyle | ViewStyle[];
}

export function Surface({
  level = 1,
  padding,
  radiusToken = 'card',
  bordered = false,
  accentEdge,
  onPress,
  shadow = 0,
  haptic = true,
  style,
  children,
  ...rest
}: SurfaceProps) {
  const { c, radius, space, motion, elevation } = useTheme();
  const scale = useSharedValue(1);

  const background =
    level === 0
      ? 'transparent'
      : level === 1
        ? c.surface
        : level === 2
          ? c.surfaceElevated
          : c.surfaceOverlay;

  const base: ViewStyle = {
    backgroundColor: background,
    borderRadius: radius[radiusToken],
    padding: padding ?? space.comfy,
    ...(bordered ? { borderWidth: 1, borderColor: c.border } : null),
    ...(accentEdge ? { borderLeftWidth: 3, borderLeftColor: accentEdge } : null),
    ...elevation(shadow),
  };

  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const onIn = useCallback(() => {
    scale.value = withSpring(0.985, motion.press);
  }, [motion, scale]);

  const onOut = useCallback(() => {
    scale.value = withSpring(1, motion.press);
  }, [motion, scale]);

  const handlePress = useCallback(() => {
    if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress?.();
  }, [haptic, onPress]);

  if (!onPress) {
    return (
      <View {...rest} style={[base, style]}>
        {children}
      </View>
    );
  }

  return (
    <Animated.View style={animated}>
      <Pressable
        {...rest}
        onPress={handlePress}
        onPressIn={onIn}
        onPressOut={onOut}
        accessibilityRole="button"
        style={[base, style]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

export default Surface;
