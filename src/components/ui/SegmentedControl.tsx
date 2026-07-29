/**
 * SegmentedControl.
 *
 * The selected indicator is a single element that slides between positions
 * rather than a background toggling on each segment. Sliding shows the
 * relationship between where selection was and where it went; toggling just
 * blinks and makes the control feel cheap.
 */

import { useCallback, useState } from 'react';
import { LayoutChangeEvent, Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/design';
import Text from './Text';

export interface Segment<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  const { c, radius, motion, space } = useTheme();
  const [trackWidth, setTrackWidth] = useState(0);
  const offset = useSharedValue(0);

  const index = Math.max(
    0,
    segments.findIndex((s) => s.value === value)
  );
  const segWidth = trackWidth > 0 ? (trackWidth - 4) / segments.length : 0;

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const w = e.nativeEvent.layout.width;
      setTrackWidth(w);
      offset.value = ((w - 4) / segments.length) * index;
    },
    [index, segments.length, offset]
  );

  const handlePress = useCallback(
    (next: T, i: number) => {
      if (next === value) return;
      Haptics.selectionAsync().catch(() => {});
      offset.value = withSpring(segWidth * i, motion.press);
      onChange(next);
    },
    [value, segWidth, motion, offset, onChange]
  );

  const indicator = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
  }));

  return (
    <View
      onLayout={onLayout}
      style={{
        flexDirection: 'row',
        backgroundColor: c.surfaceInput,
        borderRadius: radius.chip,
        padding: 2,
        position: 'relative',
      }}
    >
      {segWidth > 0 ? (
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: 2,
              left: 2,
              bottom: 2,
              width: segWidth,
              backgroundColor: c.surfaceOverlay,
              borderRadius: radius.chip,
            },
            indicator,
          ]}
        />
      ) : null}

      {segments.map((segment, i) => {
        const active = segment.value === value;
        return (
          <Pressable
            key={segment.value}
            onPress={() => handlePress(segment.value, i)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: space.snug + 2,
            }}
          >
            <Text variant="action" color={active ? 'primaryText' : 'tertiaryText'} numberOfLines={1}>
              {segment.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default SegmentedControl;
