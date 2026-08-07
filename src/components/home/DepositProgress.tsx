/**
 * DepositProgress — a deposit waiting on confirmations.
 *
 * This is the most anxious moment in the product. Someone has sent real crypto
 * and it hasn't appeared yet, and the honest answer — "the chain needs N blocks"
 * — is invisible unless the app shows it. Without this the only signal is a
 * balance that hasn't changed, which reads as lost money.
 *
 * So it shows the count, the target, and a filling bar, and names the network.
 * The tick count comes from the watcher (ARCHITECTURE.md §6), which is also
 * where the thresholds come from, so what's on screen is what the backend is
 * actually waiting for rather than an estimate.
 */

import { View } from 'react-native';
import { useTheme } from '@/design';
import { AssetGlyph, Money, Surface, Text } from '@/components/ui';
import type { Deposit } from '@/services/v2/types';

export function DepositProgress({ deposit }: { deposit: Deposit }) {
  const { c, space, radius } = useTheme();

  const ratio = Math.min(1, deposit.confirmations / Math.max(1, deposit.minConfirmations));
  const remaining = Math.max(0, deposit.minConfirmations - deposit.confirmations);

  return (
    <Surface level={1} padding={space.comfy} style={{ gap: space.base }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
        <AssetGlyph asset={deposit.asset} size={38} />
        <View style={{ flex: 1 }}>
          <Text variant="subheading">Deposit on the way</Text>
          <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
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
          height: 3,
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
    </Surface>
  );
}

export default DepositProgress;
