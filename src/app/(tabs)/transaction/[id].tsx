import { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  Image,
  Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams, useGlobalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/constants/theme";
import { type Colors } from "@/constants/colors";
import { useColors } from "@/store/appStore";
import StatusBadge from "@/components/transaction/StatusBadge";
import { api } from "@/services/api";
import { formatCurrency } from "@/utils/formatCurrency";
import { formatDate } from "@/utils/formatDate";
import { useConvertGuard } from "@/hooks/useConvertGuard";

export type TransactionStatus =
  | "pending"
  | "processing"
  | "paid"
  | "rejected";

interface Transaction {
  _id: string;
  coin?: string;
  network?: string;
  amountCrypto?: number;
  amountNaira?: number;
  rateAtTime?: number;
  walletAddress?: string;
  proofImageUrl?: string;
  proofImage?: string;
  transactionHash?: string;
  status: TransactionStatus;
  adminNote?: string;
  createdAt: string;
  paidAt?: string;
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

const STATUS_DESCRIPTION: Record<TransactionStatus, string> = {
  pending: "Waiting for payment verification",
  processing: "Your payment is being processed",
  paid: "Payment sent to your bank account",
  rejected: "Transaction was rejected",
};

const DEFAULT_COIN_COLOR = "#71717A";
const DEFAULT_COIN_SYMBOL = "?";

function getCoinColor(coin?: string): string {
  if (!coin) return DEFAULT_COIN_COLOR;
  return COIN_COLORS[coin.toUpperCase()] ?? DEFAULT_COIN_COLOR;
}

function getCoinSymbol(coin?: string): string {
  if (!coin) return DEFAULT_COIN_SYMBOL;
  return COIN_SYMBOLS[coin.toUpperCase()] ?? coin.charAt(0).toUpperCase();
}

function truncateHash(hash: string): string {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

function useTransactionId(): string | undefined {
  const local = useLocalSearchParams<{ id?: string | string[] }>();
  const global = useGlobalSearchParams<{ id?: string | string[] }>();
  const raw = local.id ?? global.id;
  if (raw == null) return undefined;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export default function TransactionDetailScreen() {
  const router = useRouter();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const id = useTransactionId();
  const [copied, setCopied] = useState(false);
  const [proofModalVisible, setProofModalVisible] = useState(false);

  const {
    data: transaction,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["transaction", id ?? ""],
    queryFn: async () => {
      const res = await api.get<{ data?: Transaction; status?: string } | Transaction>(
        `/transactions/${id}`
      );
      const raw = res.data as { data?: Transaction } & Transaction;
      const tx = raw?.data ?? raw;
      return tx as Transaction;
    },
    enabled: !!id,
  });

  const tx = transaction
    ? {
        ...transaction,
        proofImageUrl: transaction.proofImageUrl ?? transaction.proofImage,
      }
    : null;

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleCopyHash = useCallback(async () => {
    if (!tx?.transactionHash) return;
    await Clipboard.setStringAsync(tx.transactionHash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [tx?.transactionHash]);

  const { navigateToConvert } = useConvertGuard();
  const handleTryAgain = useCallback(() => {
    navigateToConvert();
  }, [navigateToConvert]);

  if (!id || (typeof id === "string" && id.length === 0)) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.headerWrap}>
          <View style={styles.headerAccent} />
          <View style={styles.header}>
            <Pressable style={styles.backBtn} onPress={handleBack} hitSlop={12}>
              <Ionicons name="arrow-back" size={24} color={c.primaryText} />
            </Pressable>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>Transaction</Text>
              <Text style={styles.headerSubtitle}>Details</Text>
            </View>
            <View style={styles.headerRight} />
          </View>
        </View>
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>Invalid transaction</Text>
          <Text style={styles.errorSub}>No transaction ID was provided.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.headerWrap}>
          <View style={styles.headerAccent} />
          <View style={styles.header}>
            <Pressable style={styles.backBtn} onPress={handleBack} hitSlop={12}>
              <Ionicons name="arrow-back" size={24} color={c.primaryText} />
            </Pressable>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>Transaction</Text>
              <Text style={styles.headerSubtitle}>Details</Text>
            </View>
            <View style={styles.headerRight} />
          </View>
        </View>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={c.primaryAccent} />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !tx) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.headerWrap}>
          <View style={styles.headerAccent} />
          <View style={styles.header}>
            <Pressable style={styles.backBtn} onPress={handleBack} hitSlop={12}>
              <Ionicons name="arrow-back" size={24} color={c.primaryText} />
            </Pressable>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>Transaction</Text>
              <Text style={styles.headerSubtitle}>Details</Text>
            </View>
            <View style={styles.headerRight} />
          </View>
        </View>
        <View style={styles.centered}>
          <View style={styles.errorIconWrap}>
            <Ionicons name="alert-circle" size={40} color={c.error} />
          </View>
          <Text style={styles.errorTitle}>{"Couldn't load transaction"}</Text>
          <Text style={styles.errorSub}>Something went wrong.</Text>
          <View style={styles.errorActions}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={handleBack}>
              <Text style={styles.secondaryBtnText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.retryBtn} onPress={() => refetch()}>
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const coin = tx.coin ?? "USDT";
  const coinColor = getCoinColor(tx.coin);
  const coinSymbol = getCoinSymbol(tx.coin);
  const title = `${coin} Conversion`;
  const proofImageUrl = tx.proofImageUrl ?? tx.proofImage;

  const adminNoteBorderColor =
    tx.status === "paid"
      ? c.primaryAccent
      : tx.status === "rejected"
        ? c.error
        : c.pending;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.headerWrap}>
        <View style={styles.headerAccent} />
        <View style={styles.header}>
          <Pressable style={styles.backBtn} onPress={handleBack} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={c.primaryText} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Transaction</Text>
            <Text style={styles.headerSubtitle}>Details</Text>
          </View>
          <View style={styles.headerRight} />
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.heroCard}>
          <View style={styles.heroTop}>
            <View style={[styles.heroCoinCircle, { backgroundColor: coinColor }]}>
              <Text style={styles.heroCoinSymbol}>{coinSymbol}</Text>
            </View>
            <View style={styles.heroTitleBlock}>
              <Text style={styles.heroTitle}>{title}</Text>
              {tx.network ? (
                <View style={styles.heroNetworkBadge}>
                  <Text style={styles.heroNetworkText}>{tx.network}</Text>
                </View>
              ) : null}
            </View>
          </View>
          <View style={styles.heroStatusRow}>
            <StatusBadge status={tx.status} />
          </View>
          <Text style={styles.statusDescription}>
            {STATUS_DESCRIPTION[tx.status]}
          </Text>
        </View>

        {/* Amounts */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Amounts</Text>
          <View style={styles.card}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Crypto sent</Text>
              <Text style={styles.detailValue}>
                {tx.amountCrypto ?? "—"} {coin}
              </Text>
            </View>
            <View style={[styles.detailRow, styles.detailRowLast]}>
              <Text style={styles.detailLabel}>Naira value</Text>
              <Text style={[styles.detailValue, styles.detailValueAccent]}>
                {tx.amountNaira != null
                  ? formatCurrency(tx.amountNaira, "NGN", true)
                  : "—"}
              </Text>
            </View>
            {tx.rateAtTime != null && (
              <View style={styles.rateRow}>
                <Text style={styles.rateText}>
                  1 {coin} = {formatCurrency(tx.rateAtTime, "NGN", true)}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Details */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Details</Text>
          <View style={styles.card}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Transaction ID</Text>
              <Text style={styles.detailValue}>#{tx._id.slice(-8)}</Text>
            </View>
            {tx.network ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Network</Text>
                <Text style={styles.detailValue}>{tx.network}</Text>
              </View>
            ) : null}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Submitted</Text>
              <Text style={styles.detailValue}>{formatDate(tx.createdAt)}</Text>
            </View>
            {tx.paidAt ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Paid at</Text>
                <Text style={styles.detailValue}>{formatDate(tx.paidAt)}</Text>
              </View>
            ) : null}
            <View style={[styles.detailRow, styles.detailRowLast]}>
              <Text style={styles.detailLabel}>Tx Hash</Text>
              {tx.transactionHash ? (
                <View style={styles.hashRow}>
                  <Text style={styles.detailValue}>
                    {truncateHash(tx.transactionHash)}
                  </Text>
                  <Pressable style={styles.copyBtn} onPress={handleCopyHash}>
                    <Ionicons
                      name={copied ? "checkmark" : "copy-outline"}
                      size={18}
                      color={c.primaryAccent}
                    />
                  </Pressable>
                </View>
              ) : (
                <Text style={styles.detailValueMuted}>Not set</Text>
              )}
            </View>
          </View>
        </View>

        {/* Payment proof */}
        {proofImageUrl ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Payment proof</Text>
            <TouchableOpacity
              style={styles.proofCard}
              onPress={() => setProofModalVisible(true)}
              activeOpacity={0.92}
            >
              <Image
                source={{ uri: proofImageUrl }}
                style={styles.proofImage}
                resizeMode="cover"
              />
              <View style={styles.proofOverlay}>
                <Ionicons name="expand-outline" size={24} color={c.primaryText} />
                <Text style={styles.tapToView}>Tap to view full image</Text>
              </View>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Admin note */}
        {tx.adminNote ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Note from admin</Text>
            <View
              style={[
                styles.adminNoteCard,
                { borderLeftColor: adminNoteBorderColor },
              ]}
            >
              <Text style={styles.adminNoteText}>{tx.adminNote}</Text>
            </View>
          </View>
        ) : null}

        {/* Bottom CTA */}
        {(tx.status === "pending" || tx.status === "rejected") && (
          <View style={styles.bottomAction}>
            {tx.status === "pending" ? (
              <View style={styles.waitingBtn}>
                <Ionicons name="time-outline" size={20} color={c.secondaryText} />
                <Text style={styles.waitingBtnText}>
                  Waiting for verification
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.tryAgainBtn}
                onPress={handleTryAgain}
                activeOpacity={0.85}
              >
                <Text style={styles.tryAgainBtnText}>Try again</Text>
                <Ionicons name="arrow-forward" size={18} color={c.buttonTextOnAccent} />
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>

      {copied && (
        <View style={styles.copiedToast}>
          <Text style={styles.copiedToastText}>Copied!</Text>
        </View>
      )}

      <Modal
        visible={proofModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setProofModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalCloseArea}
            activeOpacity={1}
            onPress={() => setProofModalVisible(false)}
          />
          <View style={styles.modalContent}>
            {proofImageUrl ? (
              <Image
                source={{ uri: proofImageUrl }}
                style={styles.modalImage}
                resizeMode="contain"
              />
            ) : null}
            <Pressable
              style={styles.modalCloseBtn}
              onPress={() => setProofModalVisible(false)}
            >
              <Ionicons name="close" size={28} color={c.primaryText} />
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const CARD_RADIUS = 16;

function createStyles(c: Colors) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: c.primaryBackground,
    },
    headerWrap: {
      backgroundColor: c.primaryBackground,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headerAccent: {
      height: 3,
      backgroundColor: c.primaryAccent,
      marginHorizontal: theme.spacing.lg,
      marginTop: theme.spacing.xs,
      borderRadius: 2,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    backBtn: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      marginLeft: -4,
    },
    headerCenter: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: "700",
      color: c.primaryText,
      letterSpacing: 0.3,
    },
    headerSubtitle: {
      fontSize: 12,
      fontWeight: "500",
      color: c.secondaryText,
      marginTop: 2,
    },
    headerRight: {
      width: 44,
      height: 44,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.xl + 32,
    },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    loadingText: {
      fontSize: 14,
      color: c.secondaryText,
      marginTop: theme.spacing.sm,
    },
    errorIconWrap: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.error,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: theme.spacing.md,
    },
    errorTitle: {
      fontSize: 18,
      fontWeight: "700",
      color: c.primaryText,
      marginBottom: theme.spacing.xs,
    },
    errorSub: {
      fontSize: 14,
      color: c.secondaryText,
      marginBottom: theme.spacing.lg,
    },
    errorActions: {
      flexDirection: "row",
      gap: theme.spacing.sm,
    },
    secondaryBtn: {
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: theme.borderRadius.button,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    secondaryBtnText: {
      fontSize: 16,
      fontWeight: "700",
      color: c.primaryText,
    },
    retryBtn: {
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: theme.borderRadius.button,
      backgroundColor: c.primaryAccent,
    },
    retryBtnText: {
      fontSize: 16,
      fontWeight: "700",
      color: c.buttonTextOnAccent,
    },
    section: {
      marginBottom: theme.spacing.lg,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: c.secondaryText,
      textTransform: "uppercase",
      letterSpacing: 1.4,
      marginBottom: theme.spacing.sm,
    },
    heroCard: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: CARD_RADIUS,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.lg,
    },
    heroTop: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: theme.spacing.md,
    },
    heroCoinCircle: {
      width: 56,
      height: 56,
      borderRadius: 28,
      alignItems: "center",
      justifyContent: "center",
      marginRight: theme.spacing.md,
    },
    heroCoinSymbol: {
      fontSize: 26,
      fontWeight: "700",
      color: "#FFFFFF",
    },
    heroTitleBlock: {
      flex: 1,
    },
    heroTitle: {
      fontSize: 18,
      fontWeight: "700",
      color: c.primaryText,
      marginBottom: theme.spacing.xs,
    },
    heroNetworkBadge: {
      alignSelf: "flex-start",
      backgroundColor: c.surfaceElevated,
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: theme.borderRadius.badge,
    },
    heroNetworkText: {
      fontSize: 12,
      fontWeight: "600",
      color: c.secondaryText,
    },
    heroStatusRow: {
      marginBottom: theme.spacing.sm,
    },
    statusDescription: {
      fontSize: 13,
      color: c.secondaryText,
      lineHeight: 18,
    },
    card: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: CARD_RADIUS,
      paddingHorizontal: theme.spacing.md,
      overflow: "hidden",
    },
    detailRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      minHeight: 48,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: 0,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    detailRowLast: {
      borderBottomWidth: 0,
    },
    detailLabel: {
      fontSize: 14,
      color: c.secondaryText,
      fontWeight: "500",
      flex: 1,
    },
    detailValue: {
      fontSize: 15,
      fontWeight: "600",
      color: c.primaryText,
    },
    detailValueAccent: {
      color: c.primaryAccent,
    },
    detailValueMuted: {
      fontSize: 14,
      fontWeight: "500",
      color: c.secondaryText,
    },
    rateRow: {
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: 0,
    },
    rateText: {
      fontSize: 12,
      color: c.secondaryText,
    },
    hashRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    copyBtn: {
      padding: 4,
    },
    proofCard: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: CARD_RADIUS,
      overflow: "hidden",
    },
    proofImage: {
      width: "100%",
      height: 200,
      backgroundColor: c.surfaceElevated,
    },
    proofOverlay: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
    },
    tapToView: {
      fontSize: 13,
      color: c.secondaryText,
      fontWeight: "500",
    },
    adminNoteCard: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderLeftWidth: 4,
      borderRadius: CARD_RADIUS,
      padding: theme.spacing.md,
    },
    adminNoteText: {
      fontSize: 14,
      color: c.primaryText,
      lineHeight: 21,
    },
    bottomAction: {
      marginTop: theme.spacing.md,
    },
    waitingBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 14,
      paddingHorizontal: 24,
      borderRadius: theme.borderRadius.button,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    waitingBtnText: {
      fontSize: 15,
      fontWeight: "600",
      color: c.secondaryText,
    },
    tryAgainBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 14,
      paddingHorizontal: 24,
      borderRadius: theme.borderRadius.button,
      backgroundColor: c.primaryAccent,
    },
    tryAgainBtnText: {
      fontSize: 16,
      fontWeight: "700",
      color: c.buttonTextOnAccent,
    },
    copiedToast: {
      position: "absolute",
      bottom: theme.spacing.xl,
      left: 0,
      right: 0,
      alignItems: "center",
    },
    copiedToastText: {
      fontSize: 14,
      fontWeight: "700",
      color: c.buttonTextOnAccent,
      backgroundColor: c.primaryAccent,
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: theme.borderRadius.badge,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.95)",
      justifyContent: "center",
    },
    modalCloseArea: {
      ...StyleSheet.absoluteFillObject,
    },
    modalContent: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    modalImage: {
      width: "100%",
      height: "80%",
    },
    modalCloseBtn: {
      position: "absolute",
      top: 50,
      right: theme.spacing.lg,
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
