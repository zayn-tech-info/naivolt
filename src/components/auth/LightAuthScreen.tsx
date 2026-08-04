import type { ReactNode } from 'react';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@/design';

interface LightAuthScreenProps {
  children: ReactNode;
}

/** Keeps auth status chrome aligned with the active application theme. */
export function LightAuthScreen({ children }: LightAuthScreenProps) {
  const { isDark } = useTheme();
  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {children}
    </>
  );
}
