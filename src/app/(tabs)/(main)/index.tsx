import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Pressable,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { colors, theme } from '@/constants/theme';
import { useAuthStore } from '@/store/authStore';
import { api } from '@/services/api';
import StatusBadge from '@/components/transaction/StatusBadge';
import { formatCurrency } from '@/utils/formatCurrency';
import { formatDate } from '@/utils/formatDate';
import { useConvertGuard } from '@/hooks/useConvertGuard';

type TransactionStatus = 'pending' | 'processing' | 'paid' | 'rejected';

interface Transaction {
  _id: string;
  amountCrypto?: number;
  amountNaira?: number;
  cryptoType?: string;
  coin?: string;
  status: TransactionStatus;
  createdAt: string;
}

interface RateResponse {
  rate?: number;
  usdtToNgn?: number;
}

// Use shared theme (same as Convert tab)
const c = colors;

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function RateSkeleton() {
  return (
    <View style={styles.rateCard}>
      <View style={styles.rateCardTop}>
        <View style={[styles.skeletonLine, { width: 70, height: 10, marginBottom: 8 }]} />
        <View style={[styles.skeletonLine, { width: 8, height: 8, borderRadius: 4 }]} />
      </View>
      <View style={[styles.skeletonLine, { width: 140, height: 24, borderRadius: 6, marginTop: 8 }]} />
      <View style={[styles.skeletonLine, { width: 100, height: 10, marginTop: 12 }]} />
    </View>
  );
}

function TransactionSkeleton() {
  return (
    <>
      {[1, 2, 3].map((i) => (
        <View key={i} style={styles.txRow}>
          <View style={[styles.txIconCircle, styles.skeletonLine]} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <View style={[styles.skeletonLine, { width: 120, height: 12, marginBottom: 6 }]} />
            <View style={[styles.skeletonLine, { width: 60, height: 10 }]} />
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <View style={[styles.skeletonLine, { width: 70, height: 12, marginBottom: 6 }]} />
            <View style={[styles.skeletonLine, { width: 48, height: 18, borderRadius: 10 }]} />
          </View>
        </View>
      ))}
    </>
  );
}

function PulsingDot() {
  const opacity = useRef(new Animated.Value(0.9)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.4,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={[styles.pulseDot, { opacity }]} />;
}

export default function HomeScreen() {
  const router = useRouter();
  const { user } = useAuthStore();

  const { navigateToConvert } = useConvertGuard();
  const {
    data: rateData,
    isLoading: rateLoading,
    isError: rateError,
    refetch: refetchRate,
  } = useQuery({
    queryKey: ['rate'],
    queryFn: async () => {
      try {
        const res = await api.get<RateResponse>('/rate');
        const rate = res.data?.rate ?? res.data?.usdtToNgn ?? 0;
        return { rate };
      } catch {
        return { rate: 0 };
      }
    },
    refetchInterval: 60 * 1000,
  });

  const {
    data: transactionsRaw = [],
    isLoading: txLoading,
    refetch: refetchTx,
  } = useQuery({
    queryKey: ['transactions'],
    queryFn: async () => {
      try {
        const res = await api.get<Transaction[] | { data?: Transaction[] }>('/transactions');
        const list = Array.isArray(res.data)
          ? res.data
          : (res.data as { data?: Transaction[] })?.data ?? [];
        return list;
      } catch {
        return [];
      }
    },
  });

  const transactions = transactionsRaw.slice(0, 3);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refetchRate(), refetchTx()]);
    } finally {
      setRefreshing(false);
    }
  }, [refetchRate, refetchTx]);

  const rate = rateData?.rate ?? 0;
  const displayRate =
    rateLoading || rateError || !rate ? '---' : formatCurrency(rate, 'NGN', true);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.primaryAccent}
          />
        }
      >
        {/* 1. Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.greetingLabel}>{getGreeting()},</Text>
            <Text style={styles.userName}>{user?.username ?? user?.name ?? 'User'}</Text>
          </View>
          <Pressable style={styles.bellBtn}>
            <Ionicons name="notifications-outline" size={22} color={c.primaryText} />
          </Pressable>
        </View>
        <Text style={styles.tagline}>Your crypto. Your Naira. Instantly.</Text>

        {/* Trust strip */}
        <View style={styles.trustStrip}>
          <View style={styles.trustItem}>
            <Ionicons name="flash-outline" size={16} color={c.primaryAccent} />
            <Text style={styles.trustText}>Fast payouts</Text>
          </View>
          <View style={styles.trustDivider} />
          <View style={styles.trustItem}>
            <Ionicons name="shield-checkmark-outline" size={16} color={c.primaryAccent} />
            <Text style={styles.trustText}>Secure</Text>
          </View>
          <View style={styles.trustDivider} />
          <View style={styles.trustItem}>
            <Ionicons name="time-outline" size={16} color={c.primaryAccent} />
            <Text style={styles.trustText}>24/7</Text>
          </View>
        </View>

        {/* 2. Live Rate Card */}
        <View style={styles.section}>
          {rateLoading ? (
            <RateSkeleton />
          ) : (
            <TouchableOpacity
              style={styles.rateCard}
              activeOpacity={0.88}
              onPress={navigateToConvert}
            >
              <View style={styles.rateCardTop}>
                <Text style={styles.rateLabel}>LIVE RATE</Text>
                <PulsingDot />
              </View>
              <View style={styles.rateMiddle}>
                <Text style={styles.ratePair}>1 USDT →</Text>
                <Text style={styles.rateValue}>{displayRate}</Text>
              </View>
              <View style={styles.rateCardDivider} />
              <Text style={styles.rateTap}>Tap to convert</Text>
              <Text style={styles.rateSub}>Rates refresh every minute</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* 3. Two Action Buttons */}
        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={styles.actionPrimary}
            onPress={navigateToConvert}
            activeOpacity={0.85}
          >
            <Ionicons name="flash" size={20} color="#000000" style={{ marginRight: 8 }} />
            <Text style={styles.actionPrimaryText}>Convert Now</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionSecondary}
            onPress={() => router.push('/(tabs)/history')}
            activeOpacity={0.85}
          >
            <Text style={styles.actionSecondaryText}>History</Text>
          </TouchableOpacity>
        </View>

        {/* Gift Card Banner */}
        <TouchableOpacity
          style={styles.giftCardBanner}
          activeOpacity={0.85}
          onPress={() => router.push('/gift-cards')}
        >
          <View style={styles.giftCardBannerLeft}>
            <Text style={styles.giftCardBannerEmoji}>🎁</Text>
            <View style={styles.giftCardBannerText}>
              <Text style={styles.giftCardBannerTitle}>Sell Gift Cards</Text>
              <Text style={styles.giftCardBannerSub}>Amazon, iTunes, Google Play & more</Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={20} color={c.primaryAccent} />
        </TouchableOpacity>

        {/* Quick tip */}
        <View style={styles.tipCard}>
          <Ionicons name="information-circle-outline" size={22} color={c.primaryAccent} style={styles.tipIcon} />
          <Text style={styles.tipText}>
            Always send on the correct network (e.g. TRC20 for USDT) to avoid permanent loss.
          </Text>
        </View>

        {/* 4. Recent Transactions */}
        <View style={styles.section}>
          <View style={styles.sectionRow}>
            <View style={styles.sectionTitleRow}>
              <Ionicons name="list-outline" size={20} color={c.primaryAccent} style={{ marginRight: 8 }} />
              <Text style={styles.sectionTitle}>Recent Transactions</Text>
            </View>
            <Pressable onPress={() => router.push('/(tabs)/history')}>
              <Text style={styles.seeAll}>See All</Text>
            </Pressable>
          </View>

          {txLoading ? (
            <TransactionSkeleton />
          ) : transactions.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyIconWrap}>
                <Ionicons name="wallet-outline" size={48} color={c.primaryAccent} />
              </View>
              <Text style={styles.emptyTitle}>No transactions yet</Text>
              <Text style={styles.emptySub}>Make your first conversion and get Naira in minutes.</Text>
              <TouchableOpacity
                style={styles.emptyBtn}
                onPress={navigateToConvert}
                activeOpacity={0.85}
              >
                <Text style={styles.emptyBtnText}>Convert Now</Text>
              </TouchableOpacity>
            </View>
          ) : (
            transactions.map((tx) => {
              const coin = (tx.coin ?? tx.cryptoType ?? 'USDT').toUpperCase();
              return (
              <View key={tx._id} style={styles.txRow}>
                <View style={styles.txIconCircle}>
                  <Text style={styles.txIconSymbol}>
                    {coin === 'BTC' ? '₿' : '₮'}
                  </Text>
                </View>
                <View style={styles.txMiddle}>
                  <Text style={styles.txTitle}>{coin} Conversion</Text>
                  <Text style={styles.txDate}>{formatDate(tx.createdAt)}</Text>
                </View>
                <View style={styles.txRight}>
                  <Text style={styles.txAmount}>
                    {tx.amountCrypto ?? 0} {coin}
                  </Text>
                  <StatusBadge status={tx.status} />
                </View>
              </View>
            );})
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: c.primaryBackground,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: theme.spacing.xl,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  headerLeft: {},
  greetingLabel: {
    fontSize: 13,
    color: c.secondaryText,
  },
  userName: {
    fontSize: 24,
    fontWeight: '800',
    color: c.primaryText,
  },
  bellBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagline: {
    fontSize: 13,
    color: c.secondaryText,
    marginBottom: theme.spacing.sm,
  },
  trustStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: theme.spacing.lg,
  },
  trustItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  trustText: {
    fontSize: 12,
    fontWeight: '600',
    color: c.primaryText,
  },
  trustDivider: {
    width: 1,
    height: 14,
    backgroundColor: c.border,
    marginHorizontal: 16,
  },
  section: {
    marginBottom: theme.spacing.lg,
  },
  rateCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    padding: 20,
    overflow: 'hidden',
  },
  rateCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  rateLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: c.secondaryText,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  pulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: c.primaryAccent,
  },
  rateMiddle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  ratePair: {
    fontSize: 14,
    color: c.secondaryText,
    fontWeight: '500',
  },
  rateValue: {
    fontSize: 26,
    fontWeight: '800',
    color: c.primaryAccent,
    letterSpacing: 0.5,
  },
  rateCardDivider: {
    height: 1,
    backgroundColor: c.border,
    marginTop: 18,
    marginBottom: 14,
  },
  rateTap: {
    fontSize: 12,
    fontWeight: '500',
    color: c.secondaryText,
    textAlign: 'center',
  },
  rateSub: {
    fontSize: 10,
    fontWeight: '500',
    color: c.secondaryText,
    textAlign: 'center',
    marginTop: 4,
    opacity: 0.8,
  },
  skeletonLine: {
    backgroundColor: c.border,
    borderRadius: 4,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: theme.spacing.lg,
  },
  actionPrimary: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    backgroundColor: c.primaryAccent,
    borderRadius: 12,
  },
  actionPrimaryText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000000',
  },
  actionSecondary: {
    flex: 1,
    height: 52,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionSecondaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: c.primaryText,
  },
  giftCardBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: c.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    borderLeftWidth: 3,
    borderLeftColor: '#a855f7',
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: theme.spacing.lg,
  },
  giftCardBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  giftCardBannerEmoji: {
    fontSize: 28,
    marginRight: 12,
  },
  giftCardBannerText: {
    flex: 1,
  },
  giftCardBannerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: c.primaryText,
  },
  giftCardBannerSub: {
    fontSize: 12,
    color: c.secondaryText,
    marginTop: 2,
  },
  tipCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    borderLeftWidth: 3,
    borderLeftColor: c.primaryAccent,
    padding: 14,
    marginBottom: theme.spacing.lg,
  },
  tipIcon: {
    marginRight: 10,
  },
  tipText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '500',
    color: c.secondaryText,
    lineHeight: 18,
  },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: c.primaryText,
  },
  seeAll: {
    fontSize: 14,
    fontWeight: '700',
    color: c.primaryAccent,
  },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
    marginBottom: 12,
  },
  txIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  txIconSymbol: {
    fontSize: 20,
    fontWeight: '700',
    color: c.primaryAccent,
  },
  txMiddle: {
    flex: 1,
  },
  txTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: c.primaryText,
  },
  txDate: {
    fontSize: 11,
    color: c.secondaryText,
    marginTop: 2,
  },
  txRight: {
    alignItems: 'flex-end',
  },
  txAmount: {
    fontSize: 14,
    fontWeight: '600',
    color: c.primaryText,
    marginBottom: 4,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.xl,
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(170, 255, 0, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: c.primaryText,
    marginTop: 16,
  },
  emptySub: {
    fontSize: 14,
    color: c.secondaryText,
    marginTop: 4,
  },
  emptyBtn: {
    marginTop: 16,
    paddingVertical: 14,
    paddingHorizontal: 24,
    backgroundColor: c.primaryAccent,
    borderRadius: 12,
  },
  emptyBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000000',
  },
});
