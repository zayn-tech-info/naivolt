import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';
import { darkColors, lightColors } from '@/constants/colors';

type ThemeMode = 'dark' | 'light';

const THEME_KEY = 'naivolt_theme_mode';
const BALANCE_HIDDEN_KEY = 'naivolt_balance_hidden';

interface AppState {
  mode: ThemeMode;
  /**
   * Whether balances are masked. Persisted because people check balances in
   * public and someone who hides theirs wants it hidden on next launch too.
   */
  balanceHidden: boolean;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
  toggleBalanceHidden: () => void;
  hydrate: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  mode: (Appearance.getColorScheme() as ThemeMode) ?? 'dark',
  balanceHidden: false,

  setMode: (mode) => {
    set({ mode });
    AsyncStorage.setItem(THEME_KEY, mode).catch(() => {});
  },

  toggleMode: () => {
    const next: ThemeMode = get().mode === 'dark' ? 'light' : 'dark';
    get().setMode(next);
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
      if (saved === 'dark' || saved === 'light') {
        set({ mode: saved });
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
