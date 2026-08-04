/**
 * The single hook a component needs. Returns the active palette plus every
 * token, so a screen has one import instead of four.
 *
 * `useColors()` from the app store stays exported and working — existing
 * screens keep compiling while they migrate.
 */

import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import { useAppStore } from '@/store/appStore';
import { darkColors, lightColors } from '@/constants/colors';
import type { Colors } from '@/constants/colors';
import { space, radius, iconSize, motion, elevation, hitSlop, minTouch, disabledOpacity } from './tokens';
import { type, fontFamily, tabular } from './typography';

export interface Theme {
  c: Colors;
  mode: 'dark' | 'light';
  isDark: boolean;
  space: typeof space;
  radius: typeof radius;
  iconSize: typeof iconSize;
  type: typeof type;
  fontFamily: typeof fontFamily;
  motion: typeof motion;
  elevation: typeof elevation;
  hitSlop: typeof hitSlop;
  minTouch: number;
  disabledOpacity: number;
  tabular: typeof tabular;
}

export type ThemeMode = Theme['mode'];

const ThemeOverrideContext = createContext<ThemeMode | null>(null);

interface ThemeOverrideProviderProps {
  mode: ThemeMode;
  children: ReactNode;
}

/**
 * Applies a palette to one journey without mutating the user's saved theme.
 * The override composes, so the nearest provider wins.
 */
export function ThemeOverrideProvider({ mode, children }: ThemeOverrideProviderProps) {
  return createElement(ThemeOverrideContext.Provider, { value: mode }, children);
}

export function useTheme(): Theme {
  const savedMode = useAppStore((s) => s.mode);
  const overrideMode = useContext(ThemeOverrideContext);
  const mode = overrideMode ?? savedMode;
  const c = mode === 'dark' ? darkColors : lightColors;

  return useMemo(
    () => ({
      c,
      mode,
      isDark: mode === 'dark',
      space,
      radius,
      iconSize,
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

export function useColors(): Colors {
  return useTheme().c;
}

/**
 * Styles keyed off the palette, memoised on it. Saves every screen writing the
 * same `useMemo(() => createStyles(c), [c])` line.
 */
export function useStyles<T>(factory: (t: Theme) => T): T {
  const t = useTheme();
  return useMemo(() => factory(t), [t, factory]);
}
