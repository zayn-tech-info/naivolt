/**
 * The single hook a component needs. Returns the active palette plus every
 * token, so a screen has one import instead of four.
 *
 * `useColors()` from the app store stays exported and working — existing
 * screens keep compiling while they migrate.
 */

import { useMemo } from 'react';
import { useAppStore, useColors } from '@/store/appStore';
import type { Colors } from '@/constants/colors';
import { space, radius, motion, elevation, hitSlop, minTouch, disabledOpacity } from './tokens';
import { type, fontFamily, tabular } from './typography';

export interface Theme {
  c: Colors;
  mode: 'dark' | 'light';
  isDark: boolean;
  space: typeof space;
  radius: typeof radius;
  type: typeof type;
  fontFamily: typeof fontFamily;
  motion: typeof motion;
  elevation: typeof elevation;
  hitSlop: typeof hitSlop;
  minTouch: number;
  disabledOpacity: number;
  tabular: typeof tabular;
}

export function useTheme(): Theme {
  const c = useColors();
  const mode = useAppStore((s) => s.mode);

  return useMemo(
    () => ({
      c,
      mode,
      isDark: mode === 'dark',
      space,
      radius,
      type,
      fontFamily,
      motion,
      elevation,
      hitSlop,
      minTouch,
      disabledOpacity,
      tabular,
    }),
    [c, mode]
  );
}

/**
 * Styles keyed off the palette, memoised on it. Saves every screen writing the
 * same `useMemo(() => createStyles(c), [c])` line.
 */
export function useStyles<T>(factory: (t: Theme) => T): T {
  const t = useTheme();
  return useMemo(() => factory(t), [t, factory]);
}

export { useColors };
