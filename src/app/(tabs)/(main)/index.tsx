/**
 * Home.
 *
 * Structure, top to bottom: who you are, what you have, what you can do, what's
 * in flight, what just happened. That order is deliberate — it descends from
 * state to action to history, so the screen answers "how much do I have" before
 * it asks anything of the user.
 *
 * **One balance, not a portfolio.** The screen shows spendable naira and nothing
 * else. There is no per-asset breakdown, because there is no longer anything a
 * user can do with a crypto balance from inside the app — listing coins would be
 * showing them a number they can't act on, and inviting the question "so how do I
 * turn this into naira?" that the UI has no answer for.
 *
 * Removed from earlier versions, and why:
 *
 *  - The asset list. See above.
 *  - The "trust strip" (Fast payouts · Secure · 24/7). Marketing copy on a
 *    screen someone opens twenty times a day. It belongs on the welcome screen,
 *    which is where a claim like that is actually read.
 *  - The gift-card banner and the network tip, as permanent fixtures. The tip
 *    now appears on the deposit screen, at the moment it's relevant — a warning
 *    about choosing the right network is useless on a screen with no address on
 *    it, and a permanent advisory is one nobody reads.
 *  - Duplicate Convert affordances. The rate card, a primary button, and an
 *    empty-state button all did the same thing.
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  EmptyState,
  Screen,
  Section,
  Skeleton,
  Stagger,
  Surface,
  Text,
} from '@/components/ui';
import BalanceHero from '@/components/home/BalanceHero';
import ActionBar, { type Action } from '@/components/home/ActionBar';
import DepositProgress from '@/components/home/DepositProgress';
import ActivityRow from '@/components/activity/ActivityRow';
import {
  useActivity,
  useKycStatus,
  useLimits,
  usePendingDeposits,
  usePortfolio,
} from '@/hooks/useExchange';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function HomeScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const { user } = useAuthStore();
  const balanceHidden = useAppStore((s) => s.balanceHidden);
  const toggleBalanceHidden = useAppStore((s) => s.toggleBalanceHidden);
  const [refreshing, setRefreshing] = useState(false);

  const portfolio = usePortfolio();
  const activity = useActivity();
  const deposits = usePendingDeposits();
  const kyc = useKycStatus();
  const limits = useLimits();

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

  const recent = (activity.data?.items ?? []).slice(0, 4);
  const pending = deposits.data ?? [];

  return (
    <Screen tabBarClearance refreshing={refreshing} onRefresh={onRefresh}>
      {/* Identity — small, because it's context, not content. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginTop: space.snug,
        }}
      >
        <View>
          <Text variant="caption" color="tertiaryText">
            {greeting()}
          </Text>
          <Text variant="subheading" style={{ marginTop: 1 }}>
            {user?.username ?? user?.name ?? 'there'}
          </Text>
        </View>

        <Pressable
          onPress={() => router.push('/(tabs)/(main)/profile')}
          accessibilityRole="button"
          accessibilityLabel="Settings"
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: c.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="person-outline" size={17} color={c.secondaryText} />
        </Pressable>
      </View>

      <Stagger index={0}>
        <BalanceHero
          ngnBalance={portfolio.data ? Number(portfolio.data.ngnBalance) : null}
          loading={portfolio.isLoading}
          hidden={balanceHidden}
          onToggleHidden={toggleBalanceHidden}
          canWithdraw={kyc.data?.canWithdraw ?? true}
          dailyRemaining={
            kyc.data?.canWithdraw && limits.data
              ? Number(limits.data.dailyRemainingNgn)
              : null
          }
          onVerify={() => router.push('/kyc')}
        />
      </Stagger>

      <Stagger index={1}>
        {/* The actions are a separate decision from the balance, not a footer to
            it. Sitting flush against the card made them read as part of it. */}
        <View style={{ marginTop: space.section }}>
          <ActionBar actions={actions} />
        </View>
      </Stagger>

      {/* In-flight deposits only appear when there are any. */}
      {pending.length > 0 ? (
        <Stagger index={2}>
          <Section title="In progress">
            <View style={{ gap: space.base }}>
              {pending.map((deposit) => (
                <DepositProgress key={deposit.id} deposit={deposit} />
              ))}
            </View>
          </Section>
        </Stagger>
      ) : null}

      <Stagger index={3}>
        <Section
          title="Recent activity"
          action={
            recent.length > 0 ? (
              <Pressable
                onPress={() => router.push('/(tabs)/(main)/history')}
                accessibilityRole="button"
              >
                <Text variant="label" color="primaryAccent">
                  See all
                </Text>
              </Pressable>
            ) : undefined
          }
        >
          {activity.isLoading ? (
            <Surface level={1} style={{ gap: space.comfy }}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
                  <Skeleton width={40} height={40} radius={20} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <Skeleton width={110} height={13} />
                    <Skeleton width={70} height={11} />
                  </View>
                  <Skeleton width={70} height={15} />
                </View>
              ))}
            </Surface>
          ) : recent.length === 0 ? (
            <EmptyState
              icon="receipt-outline"
              title="Nothing here yet"
              body="Sell a gift card to get your first naira in."
              actionLabel="Sell a gift card"
              onAction={() => router.push('/gift-cards')}
            />
          ) : (
            <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
              {recent.map((item, i) => (
                <ActivityRow
                  key={item.id}
                  item={item}
                  onPress={() => router.push(`/activity/${item.id}`)}
                  last={i === recent.length - 1}
                />
              ))}
            </Surface>
          )}
        </Section>
      </Stagger>
    </Screen>
  );
}

