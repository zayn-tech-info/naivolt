/**
 * DepositProgress — a deposit waiting on confirmations.
 *
 * Compact status row for the quiet ledger home. Shows remaining confirmations,
 * amount, and a thin meter so an in flight deposit does not look like lost money.
 */

import { View } from 'react-native';
import { useTheme } from '@/design';
import { AssetGlyph, Money, Text } from '@/components/ui';
import type { Deposit } from '@/services/v2/types';

export function DepositProgress({ deposit }: { deposit: Deposit }) {
  const { c, space, radius } = useTheme();

  const ratio = Math.min(1, deposit.confirmations / Math.max(1, deposit.minConfirmations));
  const remaining = Math.max(0, deposit.minConfirmations - deposit.confirmations);

  return (
    <View
      style={{
        gap: space.snug,
        paddingVertical: space.comfy,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
        <AssetGlyph asset={deposit.asset} size={36} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="subheading" numberOfLines={1}>
            Deposit on the way
          </Text>
          <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }} numberOfLines={1}>
            {remaining === 0
              ? 'Crediting your balance now'
              : `${remaining} more confirmation${remaining === 1 ? '' : 's'} to go`}
          </Text>
        </View>
        <Money value={Number(deposit.amount)} currency="none" suffix={deposit.asset} />
      </View>

      <View
        accessibilityRole="progressbar"
        accessibilityLabel={`${deposit.confirmations} of ${deposit.minConfirmations} confirmations`}
        style={{
          height: 2,
          borderRadius: radius.chip,
          backgroundColor: c.surfaceElevated,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: '100%',
            borderRadius: radius.chip,
            backgroundColor: c.warning,
          }}
        />
      </View>

      <Text variant="ticker" color="tertiaryText">
        {deposit.confirmations}/{deposit.minConfirmations} confirmations
      </Text>
    </View>
  );
}

export default DepositProgress;
