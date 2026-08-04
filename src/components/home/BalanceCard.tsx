/**
 * BalanceCard — spendable naira on its own surface.
 *
 * Deep brand panel using the shared card radius. Keeps balancePanel tokens
 * distinct from the accent used for actions elsewhere.
 */

import { Pressable } from 'react-native';
import { useTheme } from '@/design';
import { Surface, Text } from '@/components/ui';
import { BalanceHero } from './BalanceHero';


export interface BalanceCardProps {
  ngnBalance: number | null;
  loading?: boolean;
  hidden: boolean;
  onToggleHidden: () => void;
  /** Shown under the amount when the portfolio query failed. */
  error?: boolean;
  onRetry?: () => void;
}

export function BalanceCard({
  ngnBalance,
  loading = false,
  hidden,
  onToggleHidden,
  error = false,
  onRetry,
}: BalanceCardProps) {
  const { c, radius, space } = useTheme();

  return (
    <Surface
      level={1}
      padding={space.roomy}
      style={{
        gap: space.base,
        backgroundColor: c.balancePanel,
        borderWidth: 1,
        borderColor: c.balancePanelEdge,
        borderRadius: radius.card,
      }}
    >
      <BalanceHero
        ngnBalance={ngnBalance}
        loading={loading}
        hidden={hidden}
        onToggleHidden={onToggleHidden}
        onDeepPanel
      />
      {error && onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry loading balance"
          hitSlop={8}
        >
          <Text variant="label" color="balancePanelText">
            Could not load balance. Tap to retry
          </Text>
        </Pressable>
      ) : null}
    </Surface>
  );
}

export default BalanceCard;
