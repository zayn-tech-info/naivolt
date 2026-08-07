import { View, Text, StyleSheet } from 'react-native';
import { colors, theme } from '@/constants/theme';

export type TransactionStatus = 'pending' | 'processing' | 'paid' | 'rejected';

interface StatusBadgeProps {
  status: TransactionStatus;
}

const statusConfig: Record<
  TransactionStatus,
  { label: string; bg: string; text: string }
> = {
  pending: {
    label: 'Pending',
    bg: colors.pending,
    text: colors.buttonTextOnAccent,
  },
  processing: {
    label: 'Processing',
    bg: colors.secondaryText,
    text: colors.primaryText,
  },
  paid: {
    label: 'Paid',
    bg: colors.paid,
    text: colors.buttonTextOnAccent,
  },
  rejected: {
    label: 'Rejected',
    bg: colors.error,
    text: colors.primaryText,
  },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const { label, bg, text } = statusConfig[status];

  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.text, { color: text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: theme.borderRadius.badge,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
  },
});
