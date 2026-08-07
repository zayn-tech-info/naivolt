/**
 * Design tokens — use with colors for consistent Naivolt styling.
 * Crypto-native dark theme: heavy neon lime, rounded corners, bold typography.
 */

import { colors } from './colors';

export { colors };

export const theme = {
  colors,

  // Border radius — buttons fully rounded
  borderRadius: {
    button: 14,
    card: 12,
    input: 12,
    badge: 8,
  },

  // Spacing
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
} as const;
