/**
 * Convert — the rates board.
 *
 * Nigerian users check the rate the way others check a stock: repeatedly, and
 * against what they saw an hour ago. So this tab is built around the one figure
 * they mean by "the rate" — **naira per dollar**, not naira per coin.
 *
 * That framing is why the per-dollar rate is the hero and the coin list is
 * secondary. "₦1,520/$" is the number people compare between apps and quote to
 * each other; "1 BTC = ₦97,806,770" is a fact nobody holds in their head. Every
 * naira figure on the screen is the headline rate times a USD price, so leading
 * with it means one number explains the whole board.
 *
 * Coin rows lead with the **USD** price for the same reason: it's the real market
 * signal, and repeating a nine-digit naira figure on every row is noise. The
 * naira-per-unit sits beneath it, small, for anyone who wants it.
 *
 * This is the one place `Money live` is used — these figures genuinely move on
 * their own and the tick shows which way. Elsewhere, motion on a number would
 * imply a change that didn't happen.
 *
 * Every rate shown is what the user actually receives. Our margin is already
 * inside it (see constants/pricing.ts) and is never displayed or itemised —
 * standard for an exchange, and the reason the copy can honestly say nothing gets
 * deducted afterwards.
 */

import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  AssetGlyph,
  Money,
  Screen,
  Section,
  Skeleton,
  Stagger,
  Surface,
  Text,
} from '@/components/ui';
import ActionBar, { type Action } from '@/components/home/ActionBar';
import { useRates } from '@/hooks/useExchange';
import { ASSET_META } from '@/components/ui/AssetGlyph';

export default function ConvertScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const [refreshing, setRefreshing] = useState(false);

  const rates = useRates();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await rates.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [rates]);

  const actions: Action[] = useMemo(
    () => [
      {
        key: 'deposit',
        label: 'Deposit',
        icon: 'arrow-down-outline',
        onPress: () => router.push('/deposit'),
      },
      {
        key: 'gift-cards',
        label: 'Gift cards',
        icon: 'gift-outline',
        onPress: () => router.push('/gift-cards'),
        primary: true,
      },
      {
        key: 'withdraw',
        label: 'Withdraw',
        icon: 'arrow-up-outline',
        onPress: () => router.push('/withdraw'),
      },
    ],
    [router]
  );

  const board = rates.data?.assets ?? [];
  const ngnPerUsd = rates.data ? Number(rates.data.ngnPerUsd) : null;

  return (
    <Screen tabBarClearance refreshing={refreshing} onRefresh={onRefresh}>
      <View style={{ marginTop: space.snug, marginBottom: space.comfy }}>
        <Text variant="title">Convert</Text>
      </View>

      {/* The headline rate. This is the number people mean when they ask "what's
          the rate today?" — naira per dollar, not naira per coin. It leads the
          screen because every asset price below is this figure times a USD price,
          and because it's the one number users compare between apps. */}
      <Stagger index={0}>
        <Surface level={1} style={{ gap: space.tight }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.positive }} />
            <Text variant="eyebrow" color="tertiaryText">
              Today’s rate
            </Text>
          </View>

          {rates.isLoading ? (
            <Skeleton width={200} height={36} radius={8} style={{ marginTop: 4 }} />
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.snug }}>
              <Money value={ngnPerUsd} variant="figure" whole />
              <Text variant="body" color="secondaryText">
                per $1
              </Text>
            </View>
          )}

          <Text variant="caption" color="tertiaryText">
            This is what you get. No fees deducted after.
          </Text>
        </Surface>
      </Stagger>

      <Stagger index={1}>
        <View style={{ marginTop: space.comfy }}>
          <ActionBar actions={actions} />
        </View>
      </Stagger>

      <Stagger index={2}>
        <Section title="Coin prices">
          {rates.isLoading ? (
            <Surface level={1} style={{ gap: space.comfy }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
                  <Skeleton width={40} height={40} radius={20} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <Skeleton width={70} height={13} />
                    <Skeleton width={100} height={11} />
                  </View>
                  <Skeleton width={90} height={16} />
                </View>
              ))}
            </Surface>
          ) : board.length === 0 ? (
            <Surface level={1} style={{ alignItems: 'center', gap: space.snug }}>
              <Ionicons name="cloud-offline-outline" size={22} color={c.quaternaryText} />
              <Text variant="bodySmall" color="tertiaryText" align="center">
                Rates are unavailable right now. Pull down to try again.
              </Text>
            </Surface>
          ) : (
            <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
              {board.map((row, i) => {
                const change = row.changePct24h;
                const rose = (change ?? 0) >= 0;
                return (
                  <View
                    key={row.asset}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.base,
                      paddingVertical: space.base,
                      ...(i === board.length - 1
                        ? null
                        : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
                    }}
                  >
                    <AssetGlyph asset={row.asset} size={40} />

                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text variant="subheading">{row.asset}</Text>
                      <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
                        {ASSET_META[row.asset]?.name ?? row.asset}
                      </Text>
                    </View>

                    {/* USD price leads. The naira figure below is just this times
                        the headline rate, and ₦97,806,770 next to every coin is
                        noise — the dollar price is the actual market signal. */}
                    <View style={{ alignItems: 'flex-end' }}>
                      <Money
                        value={Number(row.usdPrice)}
                        currency="USD"
                        maxFractionDigits={Number(row.usdPrice) < 10 ? 4 : 2}
                        live
                      />
                      <View
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}
                      >
                        {change != null ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                            <Ionicons
                              name={rose ? 'caret-up' : 'caret-down'}
                              size={9}
                              color={rose ? c.positive : c.negative}
                            />
                            <Text variant="ticker" color={rose ? 'positive' : 'negative'}>
                              {Math.abs(change).toFixed(2)}%
                            </Text>
                          </View>
                        ) : null}
                        <Money
                          value={Number(row.rate)}
                          variant="amountSmall"
                          color="tertiaryText"
                          whole
                        />
                      </View>
                    </View>
                  </View>
                );
              })}
            </Surface>
          )}
        </Section>
      </Stagger>

      <Stagger index={3}>
        <View
          style={{
            flexDirection: 'row',
            gap: space.snug,
            marginTop: space.roomy,
            paddingHorizontal: space.tight,
          }}
        >
          <Ionicons name="information-circle-outline" size={14} color={c.tertiaryText} />
          <Text variant="caption" color="tertiaryText" style={{ flex: 1 }}>
            Prices update every 30 seconds. The rate above is what you receive per dollar of
            value — nothing is deducted afterwards.
          </Text>
        </View>
      </Stagger>
    </Screen>
  );
}
