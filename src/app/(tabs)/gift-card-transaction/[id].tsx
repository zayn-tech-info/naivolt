import { useState, useCallback } from "react";
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
import { Ionicons } from "@expo/vector-icons";
import { colors, theme } from "@/constants/theme";
import StatusBadge from "@/components/transaction/StatusBadge";
import { api } from "@/services/api";
import { formatCurrency } from "@/utils/formatCurrency";
import { formatDate } from "@/utils/formatDate";

type TransactionStatus = "pending" | "processing" | "paid" | "rejected";

interface GiftCardTransaction {
  _id: string;
  categoryName: string;
  emoji?: string;
  country?: string;
  currency?: string;
  denomination?: number;
  amountNaira?: number;
  rateAtTime?: number;
  proofImage?: string;
  status: TransactionStatus;
  adminNote?: string;
  createdAt: string;
  paidAt?: string;
}

const STATUS_DESCRIPTION: Record<TransactionStatus, string> = {
  pending: "Waiting for gift card verification",
  processing: "Your payout is being processed",
  paid: "Payment sent to your bank account",
  rejected: "Gift card was rejected",
};

const CARD_RADIUS = 16;
const BORDER_COLOR = "#2A2A2A";

function useTransactionId(): string | undefined {
  const local = useLocalSearchParams<{ id?: string | string[] }>();
  const global = useGlobalSearchParams<{ id?: string | string[] }>();
  const raw = local.id ?? global.id;
  if (raw == null) return undefined;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function HeaderShell({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.headerWrap}>
      <View style={styles.headerAccent} />
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={colors.primaryText} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Gift Card</Text>
          <Text style={styles.headerSubtitle}>Details</Text>
        </View>
        <View style={styles.headerRight} />
      </View>
    </View>
  );
}

export default function GiftCardTransactionDetailScreen() {
  const router = useRouter();
  const id = useTransactionId();
  const [proofModalVisible, setProofModalVisible] = useState(false);

  const handleBack = useCallback(() => router.back(), [router]);

  const {
    data: transaction,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["gift-card-transaction", id ?? ""],
    queryFn: async () => {
      const res = await api.get<{ data?: GiftCardTransaction } | GiftCardTransaction>(
        `/gift-cards/transactions/${id}`
      );
      const raw = res.data as { data?: GiftCardTransaction } & GiftCardTransaction;
      return (raw?.data ?? raw) as GiftCardTransaction;
    },
    enabled: !!id,
  });

  if (!id) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <HeaderShell onBack={handleBack} />
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
        <HeaderShell onBack={handleBack} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primaryAccent} />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !transaction) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <HeaderShell onBack={handleBack} />
        <View style={styles.centered}>
          <View style={styles.errorIconWrap}>
            <Ionicons name="alert-circle" size={40} color={colors.error} />
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

  const tx = transaction;
  const adminNoteBorderColor =
    tx.status === "paid"
      ? colors.primaryAccent
      : tx.status === "rejected"
        ? colors.error
        : colors.pending;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <HeaderShell onBack={handleBack} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.heroCard}>
          <View style={styles.heroTop}>
            <View style={styles.heroEmojiCircle}>
              <Text style={styles.heroEmoji}>{tx.emoji ?? "🎁"}</Text>
            </View>
            <View style={styles.heroTitleBlock}>
              <Text style={styles.heroTitle}>{tx.categoryName}</Text>
              {tx.currency && tx.denomination ? (
                <View style={styles.heroBadge}>
                  <Text style={styles.heroBadgeText}>
                    {tx.currency}{tx.denomination} Gift Card
                  </Text>
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

        {/* Payout */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Payout</Text>
          <View style={styles.card}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Card value</Text>
              <Text style={styles.detailValue}>
                {tx.currency ?? ""}{tx.denomination ?? "—"}
              </Text>
            </View>
            <View style={[styles.detailRow, styles.detailRowLast]}>
              <Text style={styles.detailLabel}>Naira payout</Text>
              <Text style={[styles.detailValue, styles.detailValueAccent]}>
                {tx.amountNaira != null
                  ? formatCurrency(tx.amountNaira, "NGN", true)
                  : "—"}
              </Text>
            </View>
            {tx.rateAtTime != null && (
              <View style={styles.rateRow}>
                <Text style={styles.rateText}>
                  Rate: {formatCurrency(tx.rateAtTime, "NGN", true)} per unit
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
            {tx.country ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Country</Text>
                <Text style={styles.detailValue}>{tx.country}</Text>
              </View>
            ) : null}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Submitted</Text>
              <Text style={styles.detailValue}>{formatDate(tx.createdAt)}</Text>
            </View>
            {tx.paidAt ? (
              <View style={[styles.detailRow, styles.detailRowLast]}>
                <Text style={styles.detailLabel}>Paid at</Text>
                <Text style={styles.detailValue}>{formatDate(tx.paidAt)}</Text>
              </View>
            ) : (
              <View style={[styles.detailRow, styles.detailRowLast]}>
                <Text style={styles.detailLabel}>Status</Text>
                <StatusBadge status={tx.status} />
              </View>
            )}
          </View>
        </View>

        {/* Proof image */}
        {tx.proofImage ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Card proof</Text>
            <TouchableOpacity
              style={styles.proofCard}
              onPress={() => setProofModalVisible(true)}
              activeOpacity={0.92}
            >
              <Image
                source={{ uri: tx.proofImage }}
                style={styles.proofImage}
                resizeMode="cover"
              />
              <View style={styles.proofOverlay}>
                <Ionicons name="expand-outline" size={24} color={colors.primaryText} />
                <Text style={styles.tapToView}>Tap to view full image</Text>
              </View>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Admin note */}
        {tx.adminNote ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Note from admin</Text>
            <View style={[styles.adminNoteCard, { borderLeftColor: adminNoteBorderColor }]}>
              <Text style={styles.adminNoteText}>{tx.adminNote}</Text>
            </View>
          </View>
        ) : null}

        {/* Bottom CTA */}
        {tx.status === "pending" && (
          <View style={styles.bottomAction}>
            <View style={styles.waitingBtn}>
              <Ionicons name="time-outline" size={20} color={colors.secondaryText} />
              <Text style={styles.waitingBtnText}>Waiting for verification</Text>
            </View>
          </View>
        )}
        {tx.status === "rejected" && (
          <View style={styles.bottomAction}>
            <TouchableOpacity
              style={styles.tryAgainBtn}
              onPress={() => router.push("/gift-cards")}
              activeOpacity={0.85}
            >
              <Text style={styles.tryAgainBtnText}>Sell another gift card</Text>
              <Ionicons name="arrow-forward" size={18} color={colors.buttonTextOnAccent} />
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

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
            {tx.proofImage ? (
              <Image
                source={{ uri: tx.proofImage }}
                style={styles.modalImage}
                resizeMode="contain"
              />
            ) : null}
            <Pressable
              style={styles.modalCloseBtn}
              onPress={() => setProofModalVisible(false)}
            >
              <Ionicons name="close" size={28} color={colors.primaryText} />
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0D0D0D",
  },
  headerWrap: {
    backgroundColor: "#0D0D0D",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerAccent: {
    height: 3,
    backgroundColor: "#a855f7",
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
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.primaryText,
    letterSpacing: 0.3,
  },
  headerSubtitle: {
    fontSize: 12,
    fontWeight: "500",
    color: colors.secondaryText,
    marginTop: 2,
  },
  headerRight: {
    width: 44,
    height: 44,
  },
  scroll: { flex: 1 },
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
    color: colors.secondaryText,
    marginTop: theme.spacing.sm,
  },
  errorIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.error,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing.md,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.primaryText,
    marginBottom: theme.spacing.xs,
  },
  errorSub: {
    fontSize: 14,
    color: colors.secondaryText,
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
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryBtnText: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.primaryText,
  },
  retryBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: theme.borderRadius.button,
    backgroundColor: colors.primaryAccent,
  },
  retryBtnText: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.buttonTextOnAccent,
  },
  section: {
    marginBottom: theme.spacing.lg,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.secondaryText,
    textTransform: "uppercase",
    letterSpacing: 1.4,
    marginBottom: theme.spacing.sm,
  },
  heroCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
    borderRadius: CARD_RADIUS,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.lg,
  },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: theme.spacing.md,
  },
  heroEmojiCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#1a1a2e",
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing.md,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
  },
  heroEmoji: {
    fontSize: 28,
  },
  heroTitleBlock: {
    flex: 1,
  },
  heroTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.primaryText,
    marginBottom: theme.spacing.xs,
  },
  heroBadge: {
    alignSelf: "flex-start",
    backgroundColor: colors.surfaceElevated,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: theme.borderRadius.badge,
  },
  heroBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.secondaryText,
  },
  heroStatusRow: {
    marginBottom: theme.spacing.sm,
  },
  statusDescription: {
    fontSize: 13,
    color: colors.secondaryText,
    lineHeight: 18,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
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
    borderBottomWidth: 1,
    borderBottomColor: BORDER_COLOR,
  },
  detailRowLast: {
    borderBottomWidth: 0,
  },
  detailLabel: {
    fontSize: 14,
    color: colors.secondaryText,
    fontWeight: "500",
    flex: 1,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.primaryText,
  },
  detailValueAccent: {
    color: colors.primaryAccent,
  },
  rateRow: {
    paddingVertical: theme.spacing.sm,
  },
  rateText: {
    fontSize: 12,
    color: colors.secondaryText,
  },
  proofCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
    borderRadius: CARD_RADIUS,
    overflow: "hidden",
  },
  proofImage: {
    width: "100%",
    height: 200,
    backgroundColor: colors.surfaceElevated,
  },
  proofOverlay: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: theme.spacing.md,
  },
  tapToView: {
    fontSize: 13,
    color: colors.secondaryText,
    fontWeight: "500",
  },
  adminNoteCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: BORDER_COLOR,
    borderLeftWidth: 4,
    borderRadius: CARD_RADIUS,
    padding: theme.spacing.md,
  },
  adminNoteText: {
    fontSize: 14,
    color: colors.primaryText,
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
    borderRadius: theme.borderRadius.button,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  waitingBtnText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.secondaryText,
  },
  tryAgainBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: theme.borderRadius.button,
    backgroundColor: "#a855f7",
  },
  tryAgainBtnText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#ffffff",
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
