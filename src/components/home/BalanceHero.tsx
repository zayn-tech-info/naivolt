/**
 * BalanceHero — the thesis of the app.
 *
 * One number: the user's spendable naira. As large as the screen allows, with
 * tabular digits. On the deep balance panel it uses white type.
 *
 * It shows **spendable naira**, not a portfolio total. That's deliberate: this is
 * the figure the Withdraw screen calls "Available", so the two agree.
 *
 * There is no percentage-change line. Naira doesn't move against naira.
 *
 * Balances can be hidden — people check these in public, and a five-figure
 * naira total on a bright screen is a real safety concern. The preference
 * persists.
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
  /** White type for the deep balance panel. */
  onDeepPanel?: boolean;
}

export function BalanceHero({
  ngnBalance,
  loading = false,
  hidden,
  onToggleHidden,
  onDeepPanel = false,
}: BalanceHeroProps) {
  const { c, space, radius, minTouch, hitSlop } = useTheme();

  const primaryColor = onDeepPanel ? 'balancePanelText' : 'primaryText';
  const secondaryColor = onDeepPanel ? 'balancePanelMuted' : 'secondaryText';
  const controlBg = onDeepPanel ? c.balancePanelControl : c.surfaceElevated;
  const controlIcon = onDeepPanel ? c.balancePanelText : c.secondaryText;

  const toggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onToggleHidden();
  }, [onToggleHidden]);

  return (
    <View>
      <View
        style={{
          minHeight: minTouch,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.snug,
        }}
      >
        <Text variant="eyebrow" color={secondaryColor}>
          Available balance
        </Text>
        <Pressable
          onPress={toggle}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityLabel={hidden ? 'Show balance' : 'Hide balance'}
          style={({ pressed }) => ({
            width: minTouch,
            height: minTouch,
            borderRadius: radius.control,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.82 : 1,
          })}
        >
          <View
            style={{
              width: space.spacious,
              height: space.spacious,
              borderRadius: radius.control,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: controlBg,
            }}
          >
            <Ionicons
              name={hidden ? 'eye-off-outline' : 'eye-outline'}
              size={space.comfy}
              color={controlIcon}
            />
          </View>
        </Pressable>
      </View>

      <View style={{ marginTop: space.base, minHeight: minTouch, justifyContent: 'center' }}>
        {loading ? (
          <Skeleton
            width={space.hero * 4 + space.snug}
            height={space.major}
            radius={radius.control}
          />
        ) : hidden ? (
          <Text variant="display" color={secondaryColor} accessibilityLabel="Balance hidden">
            ₦ ••••••
          </Text>
        ) : (
          <Money
            value={ngnBalance}
            variant="display"
            color={primaryColor}
            detailColor={secondaryColor}
          />
        )}
      </View>
    </View>
  );
}

export default BalanceHero;
