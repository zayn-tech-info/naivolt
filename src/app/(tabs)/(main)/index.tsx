/**
 * Home — quiet ledger.
 *
 * Structure, top to bottom: greeting, available naira, actions, pending deposits
 * when present, recent activity. Restyled to match Convert / Sell / Activity.
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/design';
import {
  Screen,
  Section,
  Skeleton,
  Stagger,
  Text,
  TopLevelHeader,
} from '@/components/ui';
import { BalanceCard } from '@/components/home/BalanceCard';
import { ActionBar, type Action } from '@/components/home/ActionBar';
import { DepositProgress } from '@/components/home/DepositProgress';
import { ActivityRow } from '@/components/activity/ActivityRow';
import { useActivity, usePendingDeposits, usePortfolio } from '@/hooks/useExchange';
import { useAppStore } from '@/store/appStore';


function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function HomeScreen() {
  const router = useRouter();
  const { c, radius, space } = useTheme();
  const balanceHidden = useAppStore((s) => s.balanceHidden);
  const toggleBalanceHidden = useAppStore((s) => s.toggleBalanceHidden);
  const [refreshing, setRefreshing] = useState(false);

  const portfolio = usePortfolio();
  const activity = useActivity();
  const deposits = usePendingDeposits();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([portfolio.refetch(), activity.refetch(), deposits.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [portfolio, activity, deposits]);

  const actions: Action[] = useMemo(
    () => [
      {
        key: 'sell',
        label: 'Sell',
        icon: 'swap-vertical-outline',
        onPress: () => router.push('/deposit'),
      },
      {
        key: 'gift-cards',
        label: 'Gift cards',
        icon: 'gift-outline',
        onPress: () => router.push('/gift-cards'),
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

  const recent = (activity.data?.items ?? []).slice(0, 4);
  const pending = deposits.data ?? [];
  const portfolioFailed = portfolio.isError && !portfolio.data;

  return (
    <Screen tabBarClearance refreshing={refreshing} onRefresh={onRefresh}>
      <TopLevelHeader
        title={greeting()}
        activityAction={() => router.push('/(tabs)/(main)/history')}
      />

      <Stagger index={0}>
        <View style={{ marginTop: space.section, gap: space.roomy }}>
          <BalanceCard
            ngnBalance={portfolio.data ? Number(portfolio.data.ngnBalance) : null}
            loading={portfolio.isLoading && !portfolio.data}
            hidden={balanceHidden}
            onToggleHidden={toggleBalanceHidden}
            error={portfolioFailed}
            onRetry={() => portfolio.refetch()}
          />
          <ActionBar actions={actions} />
        </View>
      </Stagger>

      {pending.length > 0 ? (
        <Stagger index={1}>
          <View style={{ marginTop: space.section, gap: space.base }}>
            <Text variant="eyebrow" color="tertiaryText">
              Pending deposits
            </Text>
            <View
              style={{
                borderRadius: radius.card,
                borderWidth: 1,
                borderColor: c.hairline,
                backgroundColor: c.surface,
                overflow: 'hidden',
                paddingHorizontal: space.comfy,
              }}
            >
              {pending.map((deposit, i) => (
                <View
                  key={deposit.id}
                  style={
                    i === pending.length - 1
                      ? undefined
                      : { borderBottomWidth: 1, borderBottomColor: c.hairline }
                  }
                >
                  <DepositProgress deposit={deposit} />
                </View>
              ))}
            </View>
          </View>
        </Stagger>
      ) : null}

      <Stagger index={pending.length > 0 ? 2 : 1}>
        <Section
          title="Recent activity"
          action={
            recent.length > 0 ? (
              <Pressable
                onPress={() => router.push('/(tabs)/(main)/history')}
                accessibilityRole="button"
              >
                <Text variant="caption" color="primaryAccent">
                  See all
                </Text>
              </Pressable>
            ) : undefined
          }
        >
          {activity.isLoading ? (
            <View
              style={{
                borderRadius: radius.card,
                borderWidth: 1,
                borderColor: c.hairline,
                backgroundColor: c.surface,
                padding: space.comfy,
                gap: space.comfy,
              }}
            >
              {[0, 1, 2].map((i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.comfy }}>
                  <Skeleton width={36} height={36} radius={18} />
                  <View style={{ flex: 1, gap: space.tight }}>
                    <Skeleton width={110} height={13} />
                    <Skeleton width={70} height={11} />
                  </View>
                  <Skeleton width={70} height={15} />
                </View>
              ))}
            </View>
          ) : recent.length === 0 ? (
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: space.snug,
                paddingTop: space.snug,
              }}
            >
              <Text variant="bodySmall" color="tertiaryText">
                No activity yet.
              </Text>
              <Pressable
                onPress={() => router.push('/gift-cards')}
                accessibilityRole="button"
                accessibilityLabel="Sell a gift card"
              >
                <Text variant="caption" color="primaryAccent">
                  Sell a gift card
                </Text>
              </Pressable>
            </View>
          ) : (
            <View
              style={{
                borderRadius: radius.card,
                borderWidth: 1,
                borderColor: c.hairline,
                backgroundColor: c.surface,
                overflow: 'hidden',
                paddingHorizontal: space.comfy,
              }}
            >
              {recent.map((item, i) => (
                <ActivityRow key={item.id} item={item} last={i === recent.length - 1} />
              ))}
            </View>
          )}
        </Section>
      </Stagger>
    </Screen>
  );
}
