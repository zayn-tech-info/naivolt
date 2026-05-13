import { Appearance } from 'react-native';

export const darkColors = {
  primaryBackground: '#0A0A0B',
  surface: '#16161A',
  surfaceElevated: '#1C1C22',
  surfaceInput: '#0D0D10',

  primaryAccent: '#AAFF00',
  accentDim: 'rgba(170, 255, 0, 0.15)',
  successDim: 'rgba(170, 255, 0, 0.08)',

  primaryText: '#F4F4F5',
  secondaryText: '#71717A',
  tertiaryText: '#52525B',
  buttonTextOnAccent: '#000000',

  border: '#27272A',
  borderLight: '#3F3F46',

  success: '#AAFF00',
  error: '#EF4444',
  pending: '#F59E0B',
  paid: '#AAFF00',
} as const;

export const lightColors = {
  primaryBackground: '#F5F5F7',
  surface: '#FFFFFF',
  surfaceElevated: '#EBEBF0',
  surfaceInput: '#F0F0F5',

  primaryAccent: '#5C8F00',
  accentDim: 'rgba(92, 143, 0, 0.12)',
  successDim: 'rgba(92, 143, 0, 0.08)',

  primaryText: '#18181B',
  secondaryText: '#6E6E73',
  tertiaryText: '#A1A1AA',
  buttonTextOnAccent: '#FFFFFF',

  border: '#E4E4E7',
  borderLight: '#D4D4D8',

  success: '#5C8F00',
  error: '#DC2626',
  pending: '#D97706',
  paid: '#5C8F00',
} as const;

export type Colors = { readonly [K in keyof typeof darkColors]: string };

// Default export for files that haven't been migrated to useColors() yet
export const colors = darkColors;
