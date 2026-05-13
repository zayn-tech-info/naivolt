import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';
import { darkColors, lightColors } from '@/constants/colors';

type ThemeMode = 'dark' | 'light';

const THEME_KEY = 'naivolt_theme_mode';

interface AppState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
  hydrate: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  mode: (Appearance.getColorScheme() as ThemeMode) ?? 'dark',

  setMode: (mode) => {
    set({ mode });
    AsyncStorage.setItem(THEME_KEY, mode).catch(() => {});
  },

  toggleMode: () => {
    const next: ThemeMode = get().mode === 'dark' ? 'light' : 'dark';
    get().setMode(next);
  },

  hydrate: async () => {
    try {
      const saved = await AsyncStorage.getItem(THEME_KEY);
      if (saved === 'dark' || saved === 'light') {
        set({ mode: saved });
      }
    } catch {}
  },
}));

export function useColors() {
  const mode = useAppStore((s) => s.mode);
  return mode === 'dark' ? darkColors : lightColors;
}
