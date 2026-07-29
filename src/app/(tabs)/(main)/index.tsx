/**
 * Home.
 *
 * Structure, top to bottom: who you are, what you have, what you can do, what's
 * in flight, what just happened. That order is deliberate — it descends from
 * state to action to history, so the screen answers "how much do I have" before
 * it asks anything of the user.
 *
 * Removed from the previous version, and why:
 *
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
import { View } from 'react-native';
import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  AssetGlyph,
  EmptyState,
  Money,
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
import { useActivity, usePendingDeposits, usePortfolio } from '@/hooks/useExchange';
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

  const holdings = portfolio.data?.holdings ?? [];
  // Dust hides the assets that matter. A balance worth less than a naira is
  // noise on a screen whose job is showing what you have.
  const meaningful = holdings.filter((h) => Number(h.ngnValue) >= 1);
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
          totalNgn={portfolio.data ? Number(portfolio.data.totalNgn) : null}
          changePct24h={portfolio.data?.changePct24h ?? null}
          loading={portfolio.isLoading}
          hidden={balanceHidden}
          onToggleHidden={toggleBalanceHidden}
        />
      </Stagger>

      <Stagger index={1}>
        <ActionBar actions={actions} />
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
        <Section title="Your assets">
          {portfolio.isLoading ? (
            <Surface level={1} style={{ gap: space.comfy }}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
                  <Skeleton width={40} height={40} radius={20} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <Skeleton width={90} height={13} />
                    <Skeleton width={60} height={11} />
                  </View>
                  <Skeleton width={80} height={15} />
                </View>
              ))}
            </Surface>
          ) : meaningful.length === 0 ? (
            <EmptyState
              icon="wallet-outline"
              title="Nothing here yet"
              body="Deposit crypto and it'll show up here, ready to sell for naira."
              actionLabel="Deposit crypto"
              onAction={() => router.push('/deposit')}
            />
          ) : (
            <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
              {/* Naira sits first: it's the only balance that can leave the app. */}
              {portfolio.data && Number(portfolio.data.ngnBalance) > 0 ? (
                <HoldingRow
                  asset="NGN"
                  primary="Naira"
                  secondary="Ready to withdraw"
                  amount={Number(portfolio.data.ngnBalance)}
                  currency="NGN"
                  hidden={balanceHidden}
                  onPress={() => router.push('/withdraw')}
                  last={meaningful.length === 0}
                />
              ) : null}

              {meaningful.map((holding, i) => (
                <HoldingRow
                  key={holding.asset}
                  asset={holding.asset}
                  primary={holding.asset}
                  secondary={`₦${Number(holding.rate).toLocaleString('en-NG', {
                    maximumFractionDigits: 0,
                  })} each`}
                  amount={Number(holding.balance)}
                  currency="none"
                  suffix={holding.asset}
                  subAmount={Number(holding.ngnValue)}
                  hidden={balanceHidden}
                  // Informational, not tappable. With Sell removed there is no
                  // action to take on a crypto balance from here, and a row that
                  // presses but goes nowhere is worse than one that doesn't.
                  last={i === meaningful.length - 1}
                />
              ))}
            </Surface>
          )}
        </Section>
      </Stagger>

      <Stagger index={4}>
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
              title="No activity yet"
              body="Deposits, sales and withdrawals will appear here."
              inset
            />
          ) : (
            <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
              {recent.map((item, i) => (
                <ActivityRow key={item.id} item={item} last={i === recent.length - 1} />
              ))}
            </Surface>
          )}
        </Section>
      </Stagger>
    </Screen>
  );
}

/** One asset line. Kept local — nothing else needs this shape. */
function HoldingRow({
  asset,
  primary,
  secondary,
  amount,
  currency,
  suffix,
  subAmount,
  hidden,
  onPress,
  last,
}: {
  asset: string;
  primary: string;
  secondary: string;
  amount: number;
  currency: 'NGN' | 'none';
  suffix?: string;
  subAmount?: number;
  hidden: boolean;
  /** Omit for rows with no action — the row then renders as plain content. */
  onPress?: () => void;
  last: boolean;
}) {
  const { c, space } = useTheme();

  return (
    <Surface
      level={0}
      padding={0}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.base,
        paddingVertical: space.base,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <AssetGlyph asset={asset} size={40} />

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="subheading">{primary}</Text>
        <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
          {secondary}
        </Text>
      </View>

      <View style={{ alignItems: 'flex-end' }}>
        {hidden ? (
          <Text variant="amount" color="quaternaryText">
            ••••
          </Text>
        ) : (
          <>
            <Money value={amount} currency={currency} suffix={suffix} maxFractionDigits={6} />
            {subAmount != null ? (
              <Money
                value={subAmount}
                variant="amountSmall"
                color="tertiaryText"
                style={{ marginTop: 1 }}
              />
            ) : null}
          </>
        )}
      </View>
    </Surface>
  );
}
