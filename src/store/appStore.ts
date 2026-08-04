import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance, type ColorSchemeName } from 'react-native';
import { darkColors, lightColors } from '@/constants/colors';

export type ThemeMode = 'dark' | 'light';
export type ThemePreference = ThemeMode | 'system';

const THEME_KEY = 'naivolt_theme_mode';
const BALANCE_HIDDEN_KEY = 'naivolt_balance_hidden';

interface AppState {
  themePreference: ThemePreference;
  mode: ThemeMode;
  /**
   * Whether balances are masked. Persisted because people check balances in
   * public and someone who hides theirs wants it hidden on next launch too.
   */
  balanceHidden: boolean;
  setMode: (mode: ThemePreference) => void;
  toggleMode: () => void;
  syncSystemMode: (scheme: ColorSchemeName) => void;
  toggleBalanceHidden: () => void;
  hydrate: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  themePreference: 'system',
  mode: Appearance.getColorScheme() === 'dark' ? 'dark' : 'light',
  balanceHidden: false,

  setMode: (themePreference) => {
    const systemMode: ThemeMode = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
    const mode = themePreference === 'system' ? systemMode : themePreference;
    set({ themePreference, mode });
    AsyncStorage.setItem(THEME_KEY, themePreference).catch(() => {});
  },

  toggleMode: () => {
    const next: ThemePreference = get().mode === 'dark' ? 'light' : 'dark';
    get().setMode(next);
  },

  syncSystemMode: (scheme) => {
    if (get().themePreference !== 'system') return;
    set({ mode: scheme === 'dark' ? 'dark' : 'light' });
  },

  toggleBalanceHidden: () => {
    const next = !get().balanceHidden;
    set({ balanceHidden: next });
    AsyncStorage.setItem(BALANCE_HIDDEN_KEY, next ? 'true' : 'false').catch(() => {});
  },

  hydrate: async () => {
    try {
      const [saved, hidden] = await Promise.all([
        AsyncStorage.getItem(THEME_KEY),
        AsyncStorage.getItem(BALANCE_HIDDEN_KEY),
      ]);
      if (saved === 'dark' || saved === 'light' || saved === 'system') {
        const systemMode: ThemeMode = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
        set({
          themePreference: saved,
          mode: saved === 'system' ? systemMode : saved,
        });
      }
      if (hidden === 'true') {
        set({ balanceHidden: true });
      }
    } catch {}
  },
}));

export function useColors(): import('@/constants/colors').Colors {
  const mode = useAppStore((s) => s.mode);
  return mode === 'dark' ? darkColors : lightColors;
}
