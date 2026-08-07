/**
 * BalanceHero — the thesis of the app.
 *
 * One number: the user's naira balance. As large as the screen allows, in mono,
 * sitting directly on the canvas with no card around it — a card would imply the
 * balance is one item among several, and it isn't. It's the whole screen's
 * subject.
 *
 * It shows **spendable naira**, not a portfolio total. That's deliberate: this is
 * the figure the Withdraw screen calls "Available", so the two agree. A headline
 * total that included crypto not yet converted would read as money the user can
 * send to their bank, and then Withdraw would quote them something smaller — the
 * kind of mismatch that generates support tickets and destroys trust in the
 * number.
 *
 * There is no percentage-change line. Naira doesn't move against naira, so a
 * "+2.4% today" here would be measuring nothing.
 *
 * Balances can be hidden — people check these in public, on buses and in banking
 * halls, and a five-figure naira total on a bright screen is a real safety
 * concern. The preference persists, because someone who hides their balance wants
 * it hidden next time too.
 */

import { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/design';
import { Money, Skeleton, Text } from '@/components/ui';

export interface BalanceHeroProps {
  /** Spendable naira — the same figure Withdraw calls "Available". */
  ngnBalance: number | null;
  loading?: boolean;
  hidden: boolean;
  onToggleHidden: () => void;
}

export function BalanceHero({
  ngnBalance,
  loading = false,
  hidden,
  onToggleHidden,
}: BalanceHeroProps) {
  const { c, space, hitSlop } = useTheme();

  const toggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onToggleHidden();
  }, [onToggleHidden]);

  return (
    <View style={{ paddingTop: space.roomy, paddingBottom: space.section }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
        <Text variant="eyebrow" color="tertiaryText">
          Available balance
        </Text>
        <Pressable
          onPress={toggle}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityLabel={hidden ? 'Show balance' : 'Hide balance'}
        >
          <Ionicons
            name={hidden ? 'eye-off-outline' : 'eye-outline'}
            size={15}
            color={c.tertiaryText}
          />
        </Pressable>
      </View>

      <View style={{ marginTop: space.snug, minHeight: 48, justifyContent: 'center' }}>
        {loading ? (
          <Skeleton width={230} height={44} radius={10} />
        ) : hidden ? (
          // Same mono face and size as the real figure, so revealing it doesn't
          // shift the layout.
          <Text variant="display" color="quaternaryText" accessibilityLabel="Balance hidden">
            ₦ ••••••
          </Text>
        ) : (
          <Money value={ngnBalance} variant="display" />
        )}
      </View>

      {!loading && !hidden ? (
        <Text variant="caption" color="tertiaryText" style={{ marginTop: space.snug }}>
          Ready to withdraw to your bank
        </Text>
      ) : null}
    </View>
  );
}

export default BalanceHero;
