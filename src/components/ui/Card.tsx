import { type ReactNode } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { colors, theme } from '@/constants/theme';

interface CardProps {
  children: ReactNode;
  style?: ViewStyle;
}

export default function Card({ children, style }: CardProps) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: theme.borderRadius.card,
    padding: theme.spacing.md,
  },
});
