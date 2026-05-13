import { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/constants/theme";
import { Colors } from "@/constants/colors";
import { useColors } from "@/store/appStore";
import StatusBadge from "@/components/transaction/StatusBadge";
import { api } from "@/services/api";
import { useConvertGuard } from "@/hooks/useConvertGuard";
import { formatCurrency } from "@/utils/formatCurrency";
import { formatDate } from "@/utils/formatDate";

export type TransactionStatus =
  | "pending"
  | "processing"
  | "paid"
  | "rejected";

type TabType = "crypto" | "giftcards";

interface Transaction {
  _id: string;
  coin?: string;
  network?: string;
  amountCrypto?: number;
  amountNaira?: number;
  rateAtTime?: number;
  status: TransactionStatus;
  createdAt: string;
  transactionHash?: string;
}

interface GiftCardTransaction {
  _id: string;
  categoryName: string;
  emoji?: string;
  country?: string;
  currency?: string;
  denomination?: number;
  amountNaira?: number;
  status: TransactionStatus;
  createdAt: string;
}

const COIN_COLORS: Record<string, string> = {
  USDT: "#26A17B",
  ETH: "#627EEA",
  BTC: "#F7931A",
  BNB: "#F3BA2F",
  SOL: "#9945FF",
  USDC: "#2775CA",
  LTC: "#345D9D",
};

const COIN_SYMBOLS: Record<string, string> = {
  USDT: "₮",
  BTC: "₿",
  ETH: "Ξ",
  SOL: "◎",
  BNB: "B",
  LTC: "Ł",
  USDC: "$",
};

const FILTER_OPTIONS: { value: TransactionStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "paid", label: "Paid" },
  { value: "rejected", label: "Rejected" },
];

const DEFAULT_COIN_COLOR = "#71717A";
const DEFAULT_COIN_SYMBOL = "?";

const DATE_SECTION_ORDER = ["Today", "Yesterday", "This week", "Older"] as const;
type DateSection = (typeof DATE_SECTION_ORDER)[number];

function getCoinColor(coin?: string): string {
  if (!coin) return DEFAULT_COIN_COLOR;
  return COIN_COLORS[coin.toUpperCase()] ?? DEFAULT_COIN_COLOR;
}

function getCoinSymbol(coin?: string): string {
  if (!coin) return DEFAULT_COIN_SYMBOL;
  return COIN_SYMBOLS[coin.toUpperCase()] ?? coin.charAt(0).toUpperCase();
}

function getDateSection(dateStr: string): DateSection {
  const d = new Date(dateStr);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 7);
  const t = d.getTime();
  if (t >= startOfToday.getTime()) return "Today";
  if (t >= startOfYesterday.getTime()) return "Yesterday";
  if (t >= startOfWeek.getTime()) return "This week";
  return "Older";
}

function groupByDateSection(
  list: Transaction[]
): { section: DateSection; transactions: Transaction[] }[] {
  const map = new Map<DateSection, Transaction[]>();
  for (const tx of list) {
    const section = getDateSection(tx.createdAt);
    if (!map.has(section)) map.set(section, []);
    map.get(section)!.push(tx);
  }
  return DATE_SECTION_ORDER.filter((s) => map.has(s)).map((section) => ({
    section,
    transactions: map.get(section)!,
  }));
}

function TransactionSkeleton({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.skeletonList}>
      {[1, 2, 3, 4].map((i) => (
        <View key={i} style={[styles.card, styles.cardSkeleton]}>
          <View style={styles.cardLeft}>
            <View style={[styles.coinCircle, styles.skeleton]} />
            <View style={styles.cardTextBlock}>
              <View style={[styles.skeleton, styles.skeletonTitle]} />
              <View style={[styles.skeleton, styles.skeletonSub]} />
              <View style={[styles.skeleton, styles.skeletonBadge]} />
            </View>
          </View>
          <View style={styles.cardRight}>
            <View style={[styles.skeleton, styles.skeletonAmount]} />
            <View style={[styles.skeleton, styles.skeletonAmount]} />
            <View style={[styles.skeleton, styles.skeletonStatus]} />
          </View>
        </View>
      ))}
    </View>
  );
}

export default function HistoryScreen() {
  const router = useRouter();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [activeTab, setActiveTab] = useState<TabType>("crypto");
  const [filter, setFilter] = useState<TransactionStatus | "all">("all");
  const [refreshing, setRefreshing] = useState(false);

  const {
    data: transactionsRaw = [],
    isLoading: cryptoLoading,
    isError: cryptoError,
    refetch: refetchCrypto,
  } = useQuery({
    queryKey: ["transactions"],
    queryFn: async () => {
      const res = await api.get<Transaction[] | { data: Transaction[] }>(
        "/transactions"
      );
      if (Array.isArray(res.data)) return res.data;
      return (res.data as { data?: Transaction[] })?.data ?? [];
    },
  });

  const {
    data: giftCardTxRaw = [],
    isLoading: gcLoading,
    isError: gcError,
    refetch: refetchGc,
  } = useQuery({
    queryKey: ["gift-card-transactions"],
    queryFn: async () => {
      const res = await api.get<{ data?: GiftCardTransaction[] }>(
        "/gift-cards/transactions"
      );
      return (res.data as { data?: GiftCardTransaction[] })?.data ?? [];
    },
  });

  const isLoading = activeTab === "crypto" ? cryptoLoading : gcLoading;
  const isError = activeTab === "crypto" ? cryptoError : gcError;
  const refetch = activeTab === "crypto" ? refetchCrypto : refetchGc;

  const transactions = useMemo(() => {
    if (filter === "all") return transactionsRaw;
    return transactionsRaw.filter((tx) => tx.status === filter);
  }, [transactionsRaw, filter]);

  const giftCardTransactions = useMemo(() => {
    if (filter === "all") return giftCardTxRaw;
    return giftCardTxRaw.filter((tx) => tx.status === filter);
  }, [giftCardTxRaw, filter]);

  const stats = useMemo(() => {
    const source = activeTab === "crypto" ? transactionsRaw : giftCardTxRaw;
    const total = source.length;
    const pending = source.filter((t) => t.status === "pending").length;
    const paid = source.filter((t) => t.status === "paid").length;
    const rejected = source.filter((t) => t.status === "rejected").length;
    const totalNairaPaid = source
      .filter((t) => t.status === "paid" && t.amountNaira != null)
      .reduce((sum, t) => sum + (t.amountNaira ?? 0), 0);
    return { total, pending, paid, rejected, totalNairaPaid };
  }, [transactionsRaw, giftCardTxRaw, activeTab]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refetchCrypto(), refetchGc()]);
    } finally {
      setRefreshing(false);
    }
  }, [refetchCrypto, refetchGc]);

  const handleRetry = useCallback(() => {
    refetch();
  }, [refetch]);

  const { navigateToConvert } = useConvertGuard();
  const handleConvertNow = useCallback(() => {
    navigateToConvert();
  }, [navigateToConvert]);

  const handleCardPress = useCallback(
    (id: string) => {
      router.push(`/(tabs)/transaction/${id}` as const);
    },
    [router]
  );

  const activeList = activeTab === "crypto" ? transactions : giftCardTransactions;
  const activeRaw = activeTab === "crypto" ? transactionsRaw : giftCardTxRaw;

  const showEmptyState = !isLoading && activeList.length === 0;
  const showGlobalEmpty = showEmptyState && activeRaw.length === 0;
  const showFilterEmpty = showEmptyState && activeRaw.length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.primaryAccent}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerContent}>
            <View style={styles.headerAccentLine} />
            <View style={styles.headerTextBlock}>
              <Text style={styles.headerLabel}>Transaction history</Text>
              <Text style={styles.title}>History</Text>
              <Text style={styles.subtitle}>
                {isLoading
                  ? "Loading…"
                  : `${activeRaw.length} transaction${activeRaw.length === 1 ? "" : "s"}`}
              </Text>
            </View>
          </View>
          <Pressable
            style={styles.refreshBtn}
            onPress={onRefresh}
            disabled={isLoading}
          >
            <Ionicons name="refresh" size={22} color={c.primaryAccent} />
          </Pressable>
        </View>

        {/* Type Tab Toggle */}
        <View style={styles.typeTabRow}>
          <Pressable
            style={[styles.typeTab, activeTab === "crypto" && styles.typeTabActive]}
            onPress={() => { setActiveTab("crypto"); setFilter("all"); }}
          >
            <Text style={[styles.typeTabText, activeTab === "crypto" && styles.typeTabTextActive]}>Crypto</Text>
          </Pressable>
          <Pressable
            style={[styles.typeTab, activeTab === "giftcards" && styles.typeTabActive]}
            onPress={() => { setActiveTab("giftcards"); setFilter("all"); }}
          >
            <Text style={[styles.typeTabText, activeTab === "giftcards" && styles.typeTabTextActive]}>🎁 Gift Cards</Text>
          </Pressable>
        </View>

        {isError ? (
          <View style={styles.errorBlock}>
            <View style={[styles.emptyIconWrap, { borderColor: c.error }]}>
              <Ionicons name="alert-circle" size={40} color={c.error} />
            </View>
            <Text style={styles.errorTitle}>Something went wrong</Text>
            <Text style={styles.errorSub}>
              {"We couldn't load your transactions."}
            </Text>
            <TouchableOpacity
              style={styles.retryBtn}
              onPress={handleRetry}
              activeOpacity={0.85}
            >
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Overview section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Overview</Text>
              <View style={styles.summaryCard}>
                <View style={styles.heroRow}>
                  <Text style={styles.heroLabel}>Total received</Text>
                  <Text style={styles.heroValue}>
                    {formatCurrency(stats.totalNairaPaid, "NGN", true)}
                  </Text>
                </View>
                <View style={styles.statsRow}>
                  <View style={styles.statPill}>
                    <View style={[styles.statDot, { backgroundColor: c.primaryText }]} />
                    <Text style={styles.statPillValue}>{stats.total}</Text>
                    <Text style={styles.statPillLabel}>Total</Text>
                  </View>
                  <View style={styles.statPill}>
                    <View style={[styles.statDot, { backgroundColor: c.pending }]} />
                    <Text style={[styles.statPillValue, { color: c.pending }]}>{stats.pending}</Text>
                    <Text style={styles.statPillLabel}>Pending</Text>
                  </View>
                  <View style={styles.statPill}>
                    <View style={[styles.statDot, { backgroundColor: c.paid }]} />
                    <Text style={[styles.statPillValue, { color: c.paid }]}>{stats.paid}</Text>
                    <Text style={styles.statPillLabel}>Paid</Text>
                  </View>
                  <View style={styles.statPill}>
                    <View style={[styles.statDot, { backgroundColor: c.error }]} />
                    <Text style={[styles.statPillValue, { color: c.error }]}>{stats.rejected}</Text>
                    <Text style={styles.statPillLabel}>Rejected</Text>
                  </View>
                </View>
              </View>
            </View>

            {/* Filter */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Filter</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tabsScroll}
                contentContainerStyle={styles.tabsContent}
              >
                {FILTER_OPTIONS.map((opt) => {
                  const isActive = filter === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      style={[styles.tab, isActive && styles.tabActive]}
                      onPress={() =>
                        setFilter(opt.value as TransactionStatus | "all")
                      }
                    >
                      <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            {/* Activity / Transaction list */}
            <View style={styles.section}>
              <View style={styles.sectionRow}>
                <Text style={styles.sectionTitle}>Activity</Text>
                {!showGlobalEmpty && !showFilterEmpty && !isLoading && (
                  <Text style={styles.sectionCount}>{transactions.length}</Text>
                )}
              </View>

              {isLoading ? (
                <TransactionSkeleton styles={styles} />
              ) : showGlobalEmpty ? (
                <View style={styles.emptyBlock}>
                  <View style={styles.emptyIconWrap}>
                    <Ionicons
                      name={activeTab === "crypto" ? "wallet-outline" : "gift-outline"}
                      size={40}
                      color={c.secondaryText}
                    />
                  </View>
                  <Text style={styles.emptyTitle}>No transactions yet</Text>
                  <Text style={styles.emptySub}>
                    {activeTab === "crypto"
                      ? "Convert crypto to Naira to see your history here."
                      : "Sell a gift card to see your history here."}
                  </Text>
                  {activeTab === "crypto" ? (
                    <TouchableOpacity
                      style={styles.convertBtn}
                      onPress={handleConvertNow}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="flash" size={18} color={c.primaryAccent} style={{ marginRight: 6 }} />
                      <Text style={styles.convertBtnText}>Convert Now</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={styles.convertBtn}
                      onPress={() => router.push("/gift-cards")}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.convertBtnText}>Sell Gift Card</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : showFilterEmpty ? (
                <View style={styles.emptyBlock}>
                  <View style={styles.emptyIconWrap}>
                    <Ionicons name="filter-outline" size={40} color={c.secondaryText} />
                  </View>
                  <Text style={styles.emptyTitle}>No {filter} transactions</Text>
                  <Text style={styles.emptySub}>Try a different filter to see more.</Text>
                </View>
              ) : activeTab === "crypto" ? (
                groupByDateSection(transactions).map(({ section, transactions: sectionTxs }) => (
                  <View key={section} style={styles.dateGroup}>
                    <Text style={styles.dateGroupLabel}>{section}</Text>
                    {sectionTxs.map((tx) => {
                      const coin = tx.coin ?? "USDT";
                      const coinColor = getCoinColor(tx.coin);
                      const coinSymbol = getCoinSymbol(tx.coin);
                      const title = `${coin} Conversion`;
                      const statusColor =
                        tx.status === "paid"
                          ? c.paid
                          : tx.status === "rejected"
                            ? c.error
                            : tx.status === "pending"
                              ? c.pending
                              : c.secondaryText;
                      return (
                        <Pressable
                          key={tx._id}
                          style={[styles.card, { borderLeftColor: statusColor }]}
                          onPress={() => handleCardPress(tx._id)}
                        >
                          <View style={styles.cardLeft}>
                            <View style={[styles.coinCircle, { backgroundColor: coinColor }]}>
                              <Text style={styles.coinSymbol}>{coinSymbol}</Text>
                            </View>
                            <View style={styles.cardTextBlock}>
                              <Text style={styles.cardTitle}>{title}</Text>
                              <Text style={styles.cardDate}>{formatDate(tx.createdAt)}</Text>
                              {tx.network ? (
                                <View style={styles.networkBadge}>
                                  <Text style={styles.networkText}>{tx.network}</Text>
                                </View>
                              ) : null}
                            </View>
                          </View>
                          <View style={styles.cardRight}>
                            <Text style={styles.cryptoAmount}>
                              {tx.amountCrypto ?? "—"} {coin}
                            </Text>
                            <Text style={styles.nairaAmount}>
                              {tx.amountNaira != null
                                ? formatCurrency(tx.amountNaira, "NGN", true)
                                : "—"}
                            </Text>
                            <View style={styles.cardStatusRow}>
                              <StatusBadge status={tx.status} />
                              <Ionicons name="chevron-forward" size={18} color={c.secondaryText} />
                            </View>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ))
              ) : (
                groupByDateSection(giftCardTransactions as unknown as Transaction[]).map(({ section, transactions: sectionTxs }) => (
                  <View key={section} style={styles.dateGroup}>
                    <Text style={styles.dateGroupLabel}>{section}</Text>
                    {(sectionTxs as unknown as GiftCardTransaction[]).map((tx) => {
                      const statusColor =
                        tx.status === "paid"
                          ? c.paid
                          : tx.status === "rejected"
                            ? c.error
                            : tx.status === "pending"
                              ? c.pending
                              : c.secondaryText;
                      return (
                        <Pressable
                          key={tx._id}
                          style={[styles.card, { borderLeftColor: statusColor }]}
                          onPress={() => router.push(`/(tabs)/gift-card-transaction/${tx._id}` as const)}
                        >
                          <View style={styles.cardLeft}>
                            <View style={[styles.coinCircle, { backgroundColor: '#1e1e2e' }]}>
                              <Text style={{ fontSize: 22 }}>{tx.emoji ?? "🎁"}</Text>
                            </View>
                            <View style={styles.cardTextBlock}>
                              <Text style={styles.cardTitle}>{tx.categoryName}</Text>
                              <Text style={styles.cardDate}>{formatDate(tx.createdAt)}</Text>
                              {tx.currency && tx.denomination ? (
                                <View style={styles.networkBadge}>
                                  <Text style={styles.networkText}>
                                    {tx.currency}{tx.denomination}
                                  </Text>
                                </View>
                              ) : null}
                            </View>
                          </View>
                          <View style={styles.cardRight}>
                            <Text style={styles.nairaAmount}>
                              {tx.amountNaira != null
                                ? formatCurrency(tx.amountNaira, "NGN", true)
                                : "—"}
                            </Text>
                            <View style={styles.cardStatusRow}>
                              <StatusBadge status={tx.status} />
                              <Ionicons name="chevron-forward" size={18} color={c.secondaryText} />
                            </View>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(c: Colors) {
  return StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: c.primaryBackground,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl + 16,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.lg,
  },
  headerContent: {
    flex: 1,
  },
  headerAccentLine: {
    width: 32,
    height: 3,
    borderRadius: 2,
    backgroundColor: c.primaryAccent,
    marginBottom: theme.spacing.sm,
  },
  headerTextBlock: {},
  headerLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: c.secondaryText,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  title: {
    fontSize: 30,
    fontWeight: "800",
    color: c.primaryText,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: c.secondaryText,
    marginTop: 4,
  },
  refreshBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
  },
  section: {
    marginBottom: theme.spacing.lg,
  },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing.sm,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: c.secondaryText,
    letterSpacing: 0.8,
    marginBottom: theme.spacing.md,
  },
  sectionCount: {
    fontSize: 13,
    fontWeight: "600",
    color: c.primaryAccent,
  },
  summaryCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: theme.borderRadius.card,
    padding: theme.spacing.lg,
    overflow: "hidden",
  },
  heroRow: {
    marginBottom: theme.spacing.md,
    paddingBottom: theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  heroLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: c.secondaryText,
    marginBottom: 4,
  },
  heroValue: {
    fontSize: 26,
    fontWeight: "800",
    color: c.primaryAccent,
    letterSpacing: -0.5,
  },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing.xs,
  },
  statPill: {
    flex: 1,
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
    backgroundColor: c.surfaceElevated,
    borderRadius: theme.borderRadius.badge,
  },
  statDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginBottom: 4,
  },
  statPillValue: {
    fontSize: 16,
    fontWeight: "700",
    color: c.primaryText,
  },
  statPillLabel: {
    fontSize: 10,
    fontWeight: "600",
    color: c.secondaryText,
    marginTop: 2,
  },
  typeTabRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: theme.spacing.lg,
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 4,
  },
  typeTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 10,
  },
  typeTabActive: {
    backgroundColor: c.primaryAccent,
  },
  typeTabText: {
    fontSize: 14,
    fontWeight: "600",
    color: c.secondaryText,
  },
  typeTabTextActive: {
    color: "#000000",
  },
  tabsScroll: {
    marginHorizontal: -theme.spacing.lg,
  },
  tabsContent: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: 4,
  },
  tab: {
    backgroundColor: c.surface,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: theme.borderRadius.button,
  },
  tabActive: {
    backgroundColor: c.primaryAccent,
  },
  tabText: {
    fontSize: 14,
    fontWeight: "600",
    color: c.secondaryText,
  },
  tabTextActive: {
    color: c.buttonTextOnAccent,
  },
  dateGroup: {
    marginBottom: theme.spacing.md,
  },
  dateGroupLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: c.secondaryText,
    letterSpacing: 0.5,
    marginBottom: theme.spacing.sm,
    marginLeft: 4,
  },
  card: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "stretch",
    backgroundColor: c.surface,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderColor: c.border,
    borderRadius: theme.borderRadius.card,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    overflow: "hidden",
  },
  cardSkeleton: {
    borderLeftColor: c.border,
  },
  cardLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    minWidth: 0,
  },
  coinCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing.md,
  },
  coinSymbol: {
    fontSize: 20,
    fontWeight: "700",
    color: c.buttonTextOnAccent,
  },
  cardTextBlock: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 2,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: c.primaryText,
    lineHeight: 20,
    marginBottom: 4,
  },
  cardDate: {
    fontSize: 13,
    color: c.secondaryText,
    lineHeight: 18,
    marginBottom: 6,
  },
  networkBadge: {
    alignSelf: "flex-start",
    backgroundColor: c.surfaceElevated,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: theme.borderRadius.badge,
    minHeight: 24,
    justifyContent: "center",
  },
  networkText: {
    fontSize: 11,
    color: c.secondaryText,
    fontWeight: "600",
  },
  cardRight: {
    alignItems: "flex-end",
    paddingVertical: 2,
    marginLeft: theme.spacing.md,
  },
  cryptoAmount: {
    fontSize: 15,
    fontWeight: "700",
    color: c.primaryText,
    lineHeight: 20,
    marginBottom: 4,
  },
  nairaAmount: {
    fontSize: 13,
    color: c.secondaryText,
    lineHeight: 18,
    marginBottom: 6,
  },
  cardStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 24,
  },
  emptyBlock: {
    alignItems: "center",
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: c.primaryText,
    marginTop: theme.spacing.md,
  },
  emptySub: {
    fontSize: 14,
    color: c.secondaryText,
    marginTop: theme.spacing.sm,
    textAlign: "center",
    lineHeight: 20,
  },
  convertBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.primaryAccent,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: theme.borderRadius.button,
    marginTop: theme.spacing.lg,
  },
  convertBtnText: {
    color: c.buttonTextOnAccent,
    fontWeight: "700",
    fontSize: 16,
  },
  errorBlock: {
    alignItems: "center",
    paddingVertical: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: c.primaryText,
    marginTop: theme.spacing.md,
  },
  errorSub: {
    fontSize: 14,
    color: c.secondaryText,
    marginTop: theme.spacing.xs,
    textAlign: "center",
  },
  retryBtn: {
    backgroundColor: c.primaryAccent,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: theme.borderRadius.button,
    marginTop: theme.spacing.md,
  },
  retryBtnText: {
    color: c.buttonTextOnAccent,
    fontWeight: "700",
    fontSize: 16,
  },
  skeletonList: {},
  skeleton: {
    backgroundColor: c.border,
  },
  skeletonTitle: {
    width: 120,
    height: 14,
    borderRadius: 4,
    marginBottom: 6,
  },
  skeletonSub: {
    width: 80,
    height: 12,
    borderRadius: 4,
  },
  skeletonBadge: {
    width: 60,
    height: 10,
    borderRadius: 4,
    marginTop: 8,
  },
  skeletonAmount: {
    width: 70,
    height: 12,
    borderRadius: 4,
    marginBottom: 6,
  },
  skeletonStatus: {
    width: 52,
    height: 22,
    borderRadius: theme.borderRadius.badge,
  },
  });
}
