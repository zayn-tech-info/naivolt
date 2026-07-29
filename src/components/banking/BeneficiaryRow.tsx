/**
 * BeneficiaryRow — one saved destination.
 *
 * Shows the account **name** as the primary line, not the bank. When a list holds
 * both your own accounts and other people's, "who am I paying" is the question,
 * and a column of bank names all reading "GTBank" doesn't answer it. A nickname
 * wins over the account name when set, since that's what the user chose to call it.
 *
 * The number is masked to its last four digits in mono. Full account numbers in a
 * scrollable list are shoulder-surfing surface for no benefit — the last four are
 * what people use to tell their own accounts apart, and the full number is
 * confirmed on the PIN screen before anything moves.
 */

import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Surface, Text } from '@/components/ui';
import { bankInitials, bankTint } from './BankPicker';
import type { BankAccount } from '@/services/v2/types';

export interface BeneficiaryRowProps {
  account: BankAccount;
  selected: boolean;
  onPress: () => void;
  /** Marks the most recently paid destination. */
  recent?: boolean;
}

export function BeneficiaryRow({ account, selected, onPress, recent }: BeneficiaryRowProps) {
  const { c, space } = useTheme();
  const tint = bankTint(account.bankName);
  const title = account.nickname || account.accountName;

  return (
    <Surface
      level={selected ? 2 : 1}
      radiusToken="tile"
      padding={space.base}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.base,
        borderWidth: 1,
        borderColor: selected ? c.primaryAccent : 'transparent',
      }}
      accessibilityLabel={`${title}, ${account.bankName}, ending ${account.accountNumber.slice(-4)}`}
      accessibilityState={{ selected }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: `${tint}22`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text variant="label" color={tint} style={{ fontSize: 12 }}>
          {bankInitials(account.bankName)}
        </Text>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
          <Text variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </Text>
          {recent ? (
            <Text variant="eyebrow" color="tertiaryText" style={{ fontSize: 9 }}>
              Recent
            </Text>
          ) : null}
        </View>
        <Text variant="amountSmall" color="tertiaryText" style={{ marginTop: 2 }} numberOfLines={1}>
          {account.bankName} ···{account.accountNumber.slice(-4)}
        </Text>
      </View>

      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: selected ? 0 : 1.5,
          borderColor: c.borderLight,
          backgroundColor: selected ? c.primaryAccent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected ? <Ionicons name="checkmark" size={13} color={c.buttonTextOnAccent} /> : null}
      </View>
    </Surface>
  );
}

export default BeneficiaryRow;
