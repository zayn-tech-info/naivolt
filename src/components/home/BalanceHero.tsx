/**
 * BalanceHero — the thesis of the app.
 *
 * One number, as large as the screen allows, in mono. This is the thing a user
 * opens Naivolt to see, so it gets the whole top of the screen and nothing
 * competes with it: no card, no border, no gradient. Just the figure on the
 * canvas, with its context set small and dim beneath.
 *
 * It sits flush on the background rather than inside a surface on purpose. A
 * card around the balance implies the balance is one item among several; sitting
 * directly on the canvas makes it the screen's subject.
 *
 * Balances can be hidden — people check these in public, on buses and in
 * banking halls, and a five-figure naira total on a bright screen is a real
 * safety concern. The preference persists, because someone who hides their
 * balance wants it hidden next time too.
 */

import { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/design';
import { Money, Skeleton, Text } from '@/components/ui';

export interface BalanceHeroProps {
  totalNgn: number | null;
  changePct24h: number | null;
  loading?: boolean;
  hidden: boolean;
  onToggleHidden: () => void;
}

export function BalanceHero({
  totalNgn,
  changePct24h,
  loading = false,
  hidden,
  onToggleHidden,
}: BalanceHeroProps) {
  const { c, space, hitSlop } = useTheme();

  const toggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onToggleHidden();
  }, [onToggleHidden]);

  const rose = (changePct24h ?? 0) >= 0;

  return (
    <View style={{ paddingTop: space.roomy, paddingBottom: space.section }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
        <Text variant="eyebrow" color="tertiaryText">
          Total balance
        </Text>
        <Pressable
          onPress={toggle}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityLabel={hidden ? 'Show balance' : 'Hide balance'}
        >
          <Ionicons name={hidden ? 'eye-off-outline' : 'eye-outline'} size={15} color={c.tertiaryText} />
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
          <Money value={totalNgn} variant="display" />
        )}
      </View>

      {!loading && !hidden && changePct24h != null ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: space.snug }}
        >
          <Ionicons
            name={rose ? 'trending-up' : 'trending-down'}
            size={14}
            color={rose ? c.positive : c.negative}
          />
          <Text variant="amountSmall" color={rose ? 'positive' : 'negative'}>
            {rose ? '+' : ''}
            {changePct24h.toFixed(1)}%
          </Text>
          <Text variant="caption" color="tertiaryText">
            today
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default BalanceHero;
