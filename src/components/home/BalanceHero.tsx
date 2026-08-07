/**
 * BalanceHero — the thesis of the app.
 *
 * One number: the user's spendable naira. It shows **spendable** balance, not a
 * portfolio total, because this is the figure the Withdraw screen calls
 * "Available" — a headline including unconverted crypto would read as money you
 * can send to your bank, and then Withdraw would quote something smaller.
 *
 * ## Why it is a card now
 *
 * It used to sit flush on the canvas, on the argument that a card implies the
 * balance is one item among several. True in isolation, but it left the most
 * important number on the screen looking like a caption, carrying no more weight
 * than the greeting above it. It is now a defined surface with a soft accent
 * wash, so the eye lands there first without the figure having to grow.
 *
 * The wash is faint and sits *behind* the content. A saturated brand-coloured
 * card would read as a promotion; this is a fact, and it should look like one.
 *
 * ## The footer earns its place
 *
 * It carries the daily withdrawal headroom — the only thing a person asks after
 * "how much do I have", which is "can I get it out today". When the user cannot
 * withdraw at all, the row becomes the prompt to verify, so the card explains
 * its own constraint rather than letting them discover it at the end of a
 * withdrawal.
 *
 * Balances hide, and the preference persists — people check these on buses.
 */

import { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
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
  /** Remaining daily withdrawal allowance. Null while unknown. */
  dailyRemaining?: number | null;
  /** False at tier 0, where the footer becomes a prompt to verify. */
  canWithdraw?: boolean;
  onVerify?: () => void;
}

export function BalanceHero({
  ngnBalance,
  loading = false,
  hidden,
  onToggleHidden,
  dailyRemaining,
  canWithdraw = true,
  onVerify,
}: BalanceHeroProps) {
  const { c, space, radius, isDark } = useTheme();

  const toggle = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onToggleHidden();
  }, [onToggleHidden]);

  return (
    <View
      style={{
        marginTop: space.comfy,
        borderRadius: radius.card,
        overflow: 'hidden',
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.border,
      }}
    >
      <LinearGradient
        colors={
          isDark
            ? ['rgba(170,255,0,0.10)', 'rgba(170,255,0,0.02)', 'rgba(170,255,0,0)']
            : ['rgba(79,125,0,0.08)', 'rgba(79,125,0,0.02)', 'rgba(79,125,0,0)']
        }
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      />

      <View style={{ padding: space.roomy }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
          <Text variant="eyebrow" color="tertiaryText">
            Available balance
          </Text>
          <Pressable
            onPress={toggle}
            hitSlop={12}
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
            // Same face and size as the real figure, so revealing it does not
            // shift the layout.
            <Text variant="display" color="quaternaryText" accessibilityLabel="Balance hidden">
              ₦ ••••••
            </Text>
          ) : (
            <Money value={ngnBalance} variant="display" />
          )}
        </View>
      </View>

      {!loading ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: c.hairline,
            paddingVertical: space.base,
            paddingHorizontal: space.roomy,
          }}
        >
          {canWithdraw ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
              <Ionicons name="arrow-up-circle-outline" size={14} color={c.tertiaryText} />
              <Text variant="caption" color="tertiaryText" style={{ flex: 1 }}>
                {dailyRemaining != null
                  ? `₦${dailyRemaining.toLocaleString('en-NG')} left to withdraw today`
                  : 'Ready to withdraw to your bank'}
              </Text>
            </View>
          ) : (
            <Pressable
              onPress={onVerify}
              accessibilityRole="button"
              accessibilityLabel="Verify your identity to withdraw"
              style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}
            >
              <Ionicons name="shield-outline" size={14} color={c.warning} />
              <Text variant="caption" color="secondaryText" style={{ flex: 1 }}>
                Verify your identity to withdraw
              </Text>
              <Ionicons name="chevron-forward" size={14} color={c.tertiaryText} />
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

export default BalanceHero;
