/**
 * Stagger — the page-load sequence.
 *
 * Content enters top-to-bottom with a short offset per item, which gives a
 * screen a reading order on arrival instead of everything materialising at
 * once. It's the one orchestrated motion moment in the app; individual
 * components don't animate their own entrances, or the result is noise.
 *
 * Deliberately restrained: 14px of travel and ~240ms. Anything larger reads as
 * a transition rather than a load, and on a screen someone opens twenty times a
 * day, showy entrances become an irritation fast.
 *
 * Reanimated's entering animations are automatically skipped when the OS
 * reduce-motion setting is on.
 */

import type { ReactNode } from 'react';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { motion } from '@/design/tokens';
import type { ViewStyle } from 'react-native';

export interface StaggerProps {
  children: ReactNode;
  /** Position in the sequence. 0 enters first. */
  index?: number;
  style?: ViewStyle;
}

export function Stagger({ children, index = 0, style }: StaggerProps) {
  return (
    <Animated.View
      entering={FadeInDown.delay(index * motion.stagger).duration(motion.duration.base)}
      style={style}
    >
      {children}
    </Animated.View>
  );
}

export default Stagger;
