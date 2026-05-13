import { config } from "@/constants/config";
import { type Colors } from "@/constants/colors";
import { theme } from "@/constants/theme";
import { useColors } from "@/store/appStore";
import { api } from "@/services/api";
import { formatCurrency } from "@/utils/formatCurrency";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

interface RateResponse {
  rate?: number;
}

export default function SubmitTransactionScreen() {
  const router = useRouter();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const {
    coin = "USDT",
    network = "TRC20",
    amount: amountParam = "",
    rate: rateParam = "0",
    depositAddressId = "",
  } = useLocalSearchParams<{
    coin?: string;
    network?: string;
    amount?: string;
    rate?: string;
    depositAddressId?: string;
  }>();

  const [amount, setAmount] = useState(amountParam || "");
  const [proofImage, setProofImage] = useState<{ uri: string } | null>(null);
  const [transactionHash, setTransactionHash] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  const coinSymbol = (coin || "USDT").toUpperCase();
  const coinId = coinSymbol.toLowerCase();
  const passedRate = parseFloat(rateParam) || 0;

  const { data: rateData } = useQuery({
    queryKey: ["rate", coinId],
    queryFn: async () => {
      try {
        const res = await api.get<RateResponse>(`/rate?coin=${coinId}`);
        return { rate: res.data?.rate ?? 0 };
      } catch {
        return { rate: 0 };
      }
    },
    placeholderData: passedRate > 0 ? { rate: passedRate } : undefined,
  });

  const rate = rateData?.rate ?? passedRate;
  const amountNum = useMemo(
    () => parseFloat(amount.replace(/,/g, "")) || 0,
    [amount],
  );
  const amountNaira = useMemo(
    () => (rate > 0 && amountNum > 0 ? amountNum * rate : 0),
    [rate, amountNum],
  );
  const amountNairaDisplay =
    amountNaira > 0 ? formatCurrency(amountNaira, "NGN", true) : rate === 0 ? "Loading rate…" : "—";

  const canSubmit = amountNum > 0 && proofImage !== null && rate > 0;

  const pickImage = async () => {
    try {
      const ImagePicker = await import("expo-image-picker");
      const { status } =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission needed",
          "Allow access to your photos to upload a screenshot.",
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setProofImage({ uri: result.assets[0].uri });
      }
    } catch {
      Alert.alert("Error", "Could not open photo library. Please try again.");
    }
  };

  const removeImage = () => setProofImage(null);

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) return;
    setSubmitError("");
    setIsSubmitting(true);

    try {
      const { useAuthStore } = await import("@/store/authStore");
      const token = useAuthStore.getState().token;

      const formData = new FormData();
      formData.append("coin", coinSymbol);
      formData.append("network", network || "");
      formData.append("amountCrypto", String(amountNum));
      formData.append("amountNaira", String(Math.ceil(amountNaira)));
      formData.append("rateAtTime", String(rate));
      if (transactionHash.trim())
        formData.append("transactionHash", transactionHash.trim());
      if (depositAddressId)
        formData.append("depositAddressId", depositAddressId);

      if (proofImage?.uri) {
        const filename = proofImage.uri.split("/").pop() || "proof.jpg";
        const match = /\.(jpe?g|png|webp)$/i.exec(filename);
        const mime = match ? `image/${match[1].toLowerCase()}` : "image/jpeg";
        formData.append("proofImage", {
          uri: proofImage.uri,
          name: filename,
          type: mime,
        } as unknown as Blob);
      }

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${config.apiUrl}/api/v1/transactions`);

        if (token) {
          xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        }

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            let message = "Failed to submit. Please try again.";
            try {
              const body = JSON.parse(xhr.responseText);
              message = body?.message ?? message;
            } catch {}
            if (xhr.status === 401) message = "Please log in to submit proof.";
            reject(new Error(message));
          }
        };

        xhr.onerror = () => {
          reject(
            new Error(
              `No response from server (${config.apiUrl}). Check that the backend is running.`,
            ),
          );
        };

        xhr.ontimeout = () => {
          reject(new Error("Request timed out. Please try again."));
        };

        xhr.timeout = 30000;
        xhr.send(formData);
      });

      setShowSuccessModal(true);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setSubmitError(e?.message ?? "Failed to submit. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const closeSuccessAndGoToHistory = () => {
    setShowSuccessModal(false);
    router.replace("/(tabs)/(main)/history");
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <TouchableOpacity
              onPress={() => router.back()}
              style={styles.backBtn}
              hitSlop={12}
              activeOpacity={0.8}
            >
              <Ionicons name="arrow-back" size={22} color={c.primaryText} />
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text style={styles.title}>Submit Proof</Text>
              <Text style={styles.subtitle}>
                Confirm your transaction details
              </Text>
            </View>
            <View style={styles.headerRight} />
          </View>

          <View style={styles.sectionLabelWrap}>
            <Text style={styles.sectionLabel}>Transaction details</Text>
          </View>
          <View style={styles.card}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Coin</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{coinSymbol}</Text>
              </View>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Network</Text>
              <View style={[styles.badge, styles.badgeMuted]}>
                <Text style={styles.badgeText}>{network}</Text>
              </View>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Amount sent</Text>
            </View>
            <View style={styles.amountInputWrap}>
              <TextInput
                style={styles.amountInput}
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                placeholderTextColor={c.tertiaryText}
                keyboardType="decimal-pad"
              />
              <View style={styles.amountBadge}>
                <Text style={styles.amountBadgeText}>{coinSymbol}</Text>
              </View>
            </View>
            <View style={styles.receiveRow}>
              <Text style={styles.summaryLabel}>You will receive</Text>
              <Text style={[styles.receiveValue, rate === 0 && styles.receiveValueMuted]}>
                {amountNairaDisplay}
              </Text>
            </View>
          </View>

          <View style={styles.sectionLabelWrap}>
            <Text style={styles.sectionLabel}>Proof of payment</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.cardSubtitle}>
              Screenshot your sent transaction from your wallet and upload it
              here
            </Text>
            <TouchableOpacity
              style={styles.uploadBox}
              onPress={proofImage ? undefined : pickImage}
              activeOpacity={0.85}
            >
              {proofImage ? (
                <View style={styles.previewWrap}>
                  <Image
                    source={{ uri: proofImage.uri }}
                    style={styles.previewImage}
                    resizeMode="cover"
                  />
                  <TouchableOpacity
                    style={styles.removeBtn}
                    onPress={removeImage}
                    hitSlop={12}
                  >
                    <View style={styles.removeBtnInner}>
                      <Ionicons
                        name="close"
                        size={18}
                        color={c.primaryText}
                      />
                    </View>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <View style={styles.uploadIconWrap}>
                    <Ionicons
                      name="cloud-upload-outline"
                      size={40}
                      color={c.secondaryText}
                    />
                  </View>
                  <Text style={styles.uploadTitle}>
                    Tap to upload screenshot
                  </Text>
                  <Text style={styles.uploadHint}>PNG or JPG, max 5MB</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.sectionLabelWrap}>
            <Text style={styles.sectionLabel}>Transaction hash</Text>
            <Text style={styles.optionalPill}>Optional</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.cardSubtitle}>
              Paste your tx ID for faster verification
            </Text>
            <TextInput
              style={styles.hashInput}
              value={transactionHash}
              onChangeText={setTransactionHash}
              placeholder="e.g. 0x1234abcd..."
              placeholderTextColor={c.tertiaryText}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.noticeCard}>
            <View style={styles.noticeTitleRow}>
              <Ionicons
                name="warning-outline"
                size={18}
                color={c.pending}
              />
              <Text style={styles.noticeTitle}>Before submitting</Text>
            </View>
            <Text style={styles.noticeText}>
              • Ensure you have sent the crypto to our wallet address
            </Text>
            <Text style={styles.noticeText}>
              • Fake submissions will result in account suspension
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.submitBtn,
              (!canSubmit || isSubmitting) && styles.submitBtnDisabled,
            ]}
            onPress={handleSubmit}
            disabled={!canSubmit || isSubmitting}
            activeOpacity={0.9}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color={c.buttonTextOnAccent} />
            ) : (
              <>
                <Text style={styles.submitBtnText}>
                  {rate === 0 ? "Loading rate…" : "Submit transaction"}
                </Text>
                {rate > 0 && (
                  <Ionicons
                    name="arrow-forward"
                    size={20}
                    color={c.buttonTextOnAccent}
                    style={styles.submitBtnIcon}
                  />
                )}
              </>
            )}
          </TouchableOpacity>

          {submitError ? (
            <Text style={styles.errorText}>{submitError}</Text>
          ) : null}

          <View style={styles.bottomSpacer} />
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={showSuccessModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalIconWrap}>
              <Ionicons name="checkmark-circle" size={64} color={c.primaryAccent} />
            </View>
            <Text style={styles.modalTitle}>Transaction Submitted!</Text>
            <Text style={styles.modalMessage}>
              We will verify your payment and send Naira to your bank account
              within 30 minutes
            </Text>
            <TouchableOpacity
              style={styles.modalBtn}
              onPress={closeSuccessAndGoToHistory}
              activeOpacity={0.9}
            >
              <Text style={styles.modalBtnText}>View Transaction</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function createStyles(c: Colors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.primaryBackground },
    keyboard: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24 },
    header: { flexDirection: "row", alignItems: "center", marginBottom: 24 },
    backBtn: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    headerCenter: { flex: 1 },
    headerRight: { width: 40 },
    title: {
      fontSize: 26,
      fontWeight: "800",
      color: c.primaryText,
      letterSpacing: -0.5,
    },
    subtitle: { fontSize: 14, color: c.secondaryText, marginTop: 4 },
    sectionLabelWrap: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 10,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: c.secondaryText,
      textTransform: "uppercase",
      letterSpacing: 1.2,
    },
    optionalPill: {
      fontSize: 10,
      fontWeight: "600",
      color: c.secondaryText,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.border,
      padding: 20,
      marginBottom: 20,
      ...Platform.select({
        ios: {
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.2,
          shadowRadius: 8,
        },
        android: { elevation: 3 },
      }),
    },
    cardSubtitle: {
      fontSize: 13,
      color: c.secondaryText,
      marginBottom: 16,
      lineHeight: 18,
    },
    summaryRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 14,
    },
    summaryLabel: { fontSize: 14, color: c.secondaryText, fontWeight: "500" },
    badge: {
      backgroundColor: c.accentDim,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 10,
    },
    badgeMuted: { backgroundColor: c.borderLight },
    badgeText: { fontSize: 13, fontWeight: "700", color: c.primaryText },
    amountInputWrap: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surfaceInput,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
      marginBottom: 16,
    },
    amountInput: {
      flex: 1,
      fontSize: 20,
      fontWeight: "700",
      color: c.primaryText,
      paddingVertical: 0,
      paddingHorizontal: 0,
    },
    amountBadge: {
      backgroundColor: c.borderLight,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      marginLeft: 12,
    },
    amountBadgeText: {
      fontSize: 13,
      fontWeight: "700",
      color: c.primaryText,
    },
    receiveRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: 14,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    receiveValue: { fontSize: 18, fontWeight: "800", color: c.primaryAccent },
    receiveValueMuted: { color: c.secondaryText, fontSize: 14, fontWeight: "500" },
    uploadBox: {
      height: 200,
      borderRadius: 16,
      borderWidth: 2,
      borderStyle: "dashed",
      borderColor: c.border,
      backgroundColor: c.surfaceInput,
      alignItems: "center",
      justifyContent: "center",
    },
    uploadIconWrap: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: c.surface,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 12,
    },
    uploadTitle: { fontSize: 15, fontWeight: "600", color: c.secondaryText },
    uploadHint: { fontSize: 12, color: c.tertiaryText, marginTop: 4 },
    previewWrap: {
      width: "100%",
      height: "100%",
      position: "relative",
      borderRadius: 14,
      overflow: "hidden",
    },
    previewImage: { width: "100%", height: "100%" },
    removeBtn: { position: "absolute", top: 12, right: 12 },
    removeBtnInner: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: "rgba(0,0,0,0.6)",
      alignItems: "center",
      justifyContent: "center",
    },
    hashInput: {
      backgroundColor: c.surfaceInput,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      padding: 14,
      fontSize: 14,
      color: c.primaryText,
    },
    noticeCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderLeftWidth: 4,
      borderLeftColor: c.pending,
      borderWidth: 1,
      borderColor: c.border,
      padding: 18,
      marginBottom: 24,
    },
    noticeTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 10,
    },
    noticeTitle: { fontSize: 14, fontWeight: "700", color: c.pending },
    noticeText: {
      fontSize: 13,
      color: c.secondaryText,
      marginBottom: 6,
      lineHeight: 18,
    },
    submitBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      backgroundColor: c.primaryAccent,
      borderRadius: 14,
      height: 56,
      ...Platform.select({
        ios: {
          shadowColor: c.primaryAccent,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.3,
          shadowRadius: 8,
        },
        android: { elevation: 4 },
      }),
    },
    submitBtnDisabled: { backgroundColor: c.secondaryText, opacity: 0.6 },
    submitBtnText: { fontSize: 16, fontWeight: "700", color: c.buttonTextOnAccent },
    submitBtnIcon: { marginLeft: 0 },
    errorText: {
      fontSize: 14,
      color: c.error,
      marginTop: 12,
      textAlign: "center",
    },
    bottomSpacer: { height: 24 },
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.65)",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    modalCard: {
      backgroundColor: c.surface,
      borderRadius: 24,
      padding: 32,
      width: "100%",
      maxWidth: 340,
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.border,
      ...Platform.select({
        ios: {
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 8 },
          shadowOpacity: 0.35,
          shadowRadius: 24,
        },
        android: { elevation: 8 },
      }),
    },
    modalIconWrap: { marginBottom: 20 },
    modalTitle: {
      fontSize: 22,
      fontWeight: "800",
      color: c.primaryText,
      marginBottom: 12,
      textAlign: "center",
    },
    modalMessage: {
      fontSize: 15,
      color: c.secondaryText,
      textAlign: "center",
      marginBottom: 28,
      lineHeight: 22,
    },
    modalBtn: {
      backgroundColor: c.primaryAccent,
      borderRadius: 14,
      paddingVertical: 16,
      paddingHorizontal: 28,
      width: "100%",
      alignItems: "center",
    },
    modalBtnText: { fontSize: 16, fontWeight: "700", color: c.buttonTextOnAccent },
  });
}
