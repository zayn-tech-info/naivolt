import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  Modal,
  FlatList,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/constants/theme";
import { type Colors } from "@/constants/colors";
import { useColors } from "@/store/appStore";
import { api } from "@/services/api";

interface BankAccount {
  _id: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  bankCode?: string;
  isDefault: boolean;
}

interface BankOption {
  name: string;
  code: string;
}

interface ApiBankAccountsResponse {
  data?: BankAccount[];
}

interface ApiBanksResponse {
  data?: BankOption[];
}

export default function BankDetailsScreen() {
  const router = useRouter();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const queryClient = useQueryClient();

  const { data: bankAccounts = [], isLoading, refetch } = useQuery({
    queryKey: ["bankAccounts"],
    queryFn: async () => {
      const res = await api.get<ApiBankAccountsResponse>("/bank-accounts");
      return (res.data as ApiBankAccountsResponse)?.data ?? [];
    },
  });

  const hasAccount = bankAccounts.length > 0;
  const account = bankAccounts[0] ?? null;

  const handleDelete = useCallback(() => {
    if (!account) return;
    Alert.alert(
      "Remove bank account",
      `Remove ${account.bankName} ending in ${account.accountNumber.slice(-4)}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await api.delete(`/bank-accounts/${account._id}`);
              queryClient.invalidateQueries({ queryKey: ["bankAccounts"] });
              refetch();
            } catch {
              Alert.alert("Error", "Failed to remove bank account. Please try again.");
            }
          },
        },
      ]
    );
  }, [account, queryClient, refetch]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={c.primaryText} />
        </Pressable>
        <Text style={styles.headerTitle}>Bank Account</Text>
        <View style={styles.headerRight} />
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={c.primaryAccent} />
        </View>
      ) : hasAccount && account ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.accountCard}>
            <View style={styles.accountCardTop}>
              <View style={styles.bankIconWrap}>
                <Ionicons name="business-outline" size={28} color={c.primaryAccent} />
              </View>
              <View style={styles.bankInfo}>
                <Text style={styles.bankName}>{account.bankName}</Text>
                <Text style={styles.accountNumber}>{account.accountNumber}</Text>
                <Text style={styles.accountName}>{account.accountName}</Text>
              </View>
              {account.isDefault && (
                <View style={styles.defaultBadge}>
                  <Text style={styles.defaultBadgeText}>Default</Text>
                </View>
              )}
            </View>
          </View>

          <View style={styles.infoCard}>
            <Ionicons name="information-circle-outline" size={18} color={c.secondaryText} />
            <Text style={styles.infoText}>
              Payments are sent to this account. You can remove it and add a different one.
            </Text>
          </View>

          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={handleDelete}
            activeOpacity={0.85}
          >
            <Ionicons name="trash-outline" size={18} color={c.error} />
            <Text style={styles.deleteBtnText}>Remove bank account</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <AddBankForm
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ["bankAccounts"] });
            refetch();
          }}
        />
      )}
    </SafeAreaView>
  );
}

function AddBankForm({ onSuccess }: { onSuccess: () => void }) {
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const [selectedBank, setSelectedBank] = useState<BankOption | null>(null);
  const [accountNumber, setAccountNumber] = useState("");
  const [resolvedAccountName, setResolvedAccountName] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [bankPickerVisible, setBankPickerVisible] = useState(false);
  const [bankSearch, setBankSearch] = useState("");

  const { data: banksData } = useQuery({
    queryKey: ["banks"],
    queryFn: async () => {
      const res = await api.get<ApiBanksResponse>("/banks");
      return (res.data as ApiBanksResponse)?.data ?? [];
    },
  });

  const filteredBanks = useMemo(() => {
    const banks = banksData ?? [];
    if (!bankSearch.trim()) return banks;
    const q = bankSearch.trim().toLowerCase();
    return banks.filter((b) => b.name.toLowerCase().includes(q));
  }, [banksData, bankSearch]);

  useEffect(() => {
    if (!selectedBank || accountNumber.replace(/\D/g, "").length !== 10) {
      setResolvedAccountName("");
      setResolveError("");
      return;
    }
    const num = accountNumber.replace(/\D/g, "").slice(0, 10);
    let cancelled = false;
    setResolving(true);
    setResolveError("");
    setResolvedAccountName("");
    api
      .get<{ data?: { account_name: string } }>(
        `/banks/resolve?account_number=${encodeURIComponent(num)}&bank_code=${encodeURIComponent(selectedBank.code)}`
      )
      .then((res) => {
        if (cancelled) return;
        const name = (res.data as { data?: { account_name: string } })?.data?.account_name;
        if (name) {
          setResolvedAccountName(name);
          setResolveError("");
        } else {
          setResolveError("Could not verify account");
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg =
          (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Could not verify account number.";
        setResolveError(msg);
        setResolvedAccountName("");
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBank, accountNumber]);

  const submit = async () => {
    setError("");
    if (!selectedBank) {
      setError("Please select a bank");
      return;
    }
    const num = accountNumber.replace(/\D/g, "").trim();
    if (num.length !== 10) {
      setError("Account number must be exactly 10 digits");
      return;
    }
    if (!resolvedAccountName) {
      setError("Please wait for account name verification");
      return;
    }
    setLoading(true);
    try {
      await api.post("/bank-accounts", {
        bankName: selectedBank.name,
        accountNumber: num,
        accountName: resolvedAccountName,
        bankCode: selectedBank.code,
      });
      onSuccess();
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to add bank account.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = !loading && !resolving && !!resolvedAccountName && !!selectedBank;

  return (
    <KeyboardAvoidingView
      style={styles.kav}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.formHeading}>Add your bank account</Text>
        <Text style={styles.formSubtext}>
          We'll send your Naira payments directly to this account.
        </Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Text style={styles.inputLabel}>Bank</Text>
        <TouchableOpacity
          style={styles.bankSelectBtn}
          onPress={() => setBankPickerVisible(true)}
          activeOpacity={0.85}
        >
          <Text style={selectedBank ? styles.bankSelectText : styles.bankSelectPlaceholder}>
            {selectedBank ? selectedBank.name : "Select your bank"}
          </Text>
          <Ionicons name="chevron-down" size={20} color={c.secondaryText} />
        </TouchableOpacity>

        <Text style={styles.inputLabel}>Account Number</Text>
        <TextInput
          style={styles.input}
          value={accountNumber}
          onChangeText={(t) => setAccountNumber(t.replace(/\D/g, "").slice(0, 10))}
          placeholder="Enter 10-digit account number"
          placeholderTextColor={c.secondaryText}
          keyboardType="number-pad"
          maxLength={10}
        />

        <Text style={styles.inputLabel}>Account Name</Text>
        <View style={styles.resolvedBox}>
          {resolving ? (
            <View style={styles.resolvedRow}>
              <ActivityIndicator size="small" color={c.primaryAccent} />
              <Text style={styles.resolvedLabel}>Verifying account…</Text>
            </View>
          ) : resolveError ? (
            <Text style={styles.resolveError}>{resolveError}</Text>
          ) : resolvedAccountName ? (
            <View style={styles.resolvedRow}>
              <Ionicons name="checkmark-circle" size={20} color={c.primaryAccent} />
              <Text style={styles.resolvedName}>{resolvedAccountName}</Text>
            </View>
          ) : (
            <Text style={styles.resolvedHint}>
              {selectedBank
                ? "Enter your account number above to verify"
                : "Select a bank first"}
            </Text>
          )}
        </View>

        <TouchableOpacity
          style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
          onPress={submit}
          disabled={!canSubmit}
          activeOpacity={0.9}
        >
          {loading ? (
            <ActivityIndicator color={c.buttonTextOnAccent} />
          ) : (
            <Text style={styles.submitBtnText}>Save Bank Account</Text>
          )}
        </TouchableOpacity>
      </ScrollView>

      <Modal visible={bankPickerVisible} transparent animationType="slide">
        <View style={styles.pickerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setBankPickerVisible(false)} />
          <View style={styles.pickerBox}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Select bank</Text>
              <TouchableOpacity onPress={() => setBankPickerVisible(false)}>
                <Text style={styles.pickerDone}>Done</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.pickerSearch}
              value={bankSearch}
              onChangeText={setBankSearch}
              placeholder="Search banks..."
              placeholderTextColor={c.secondaryText}
              autoFocus
            />
            <FlatList
              data={filteredBanks}
              keyExtractor={(item) => item.code}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.pickerItem}
                  onPress={() => {
                    setSelectedBank(item);
                    setBankPickerVisible(false);
                    setBankSearch("");
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.pickerItemText}>{item.name}</Text>
                  {selectedBank?.code === item.code && (
                    <Ionicons name="checkmark" size={18} color={c.primaryAccent} />
                  )}
                </TouchableOpacity>
              )}
              ItemSeparatorComponent={() => <View style={styles.pickerSep} />}
              style={styles.pickerList}
            />
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function createStyles(c: Colors) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: c.primaryBackground,
    },
    kav: {
      flex: 1,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    backBtn: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: {
      flex: 1,
      fontSize: 18,
      fontWeight: "700",
      color: c.primaryText,
      textAlign: "center",
    },
    headerRight: {
      width: 44,
    },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.xl,
    },
    accountCard: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.md,
    },
    accountCardTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
    },
    bankIconWrap: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: c.accentDim,
      alignItems: "center",
      justifyContent: "center",
    },
    bankInfo: {
      flex: 1,
    },
    bankName: {
      fontSize: 16,
      fontWeight: "700",
      color: c.primaryText,
      marginBottom: 3,
    },
    accountNumber: {
      fontSize: 14,
      fontWeight: "600",
      color: c.secondaryText,
      marginBottom: 2,
      letterSpacing: 0.5,
    },
    accountName: {
      fontSize: 13,
      color: c.secondaryText,
    },
    defaultBadge: {
      backgroundColor: c.accentDim,
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 8,
    },
    defaultBadgeText: {
      fontSize: 11,
      fontWeight: "700",
      color: c.primaryAccent,
    },
    infoCard: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
    },
    infoText: {
      flex: 1,
      fontSize: 13,
      color: c.secondaryText,
      lineHeight: 19,
    },
    deleteBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderWidth: 1,
      borderColor: c.error,
      borderRadius: theme.borderRadius.button,
      paddingVertical: 14,
    },
    deleteBtnText: {
      fontSize: 15,
      fontWeight: "600",
      color: c.error,
    },
    formHeading: {
      fontSize: 22,
      fontWeight: "800",
      color: c.primaryText,
      marginBottom: theme.spacing.xs,
    },
    formSubtext: {
      fontSize: 14,
      color: c.secondaryText,
      marginBottom: theme.spacing.lg,
      lineHeight: 20,
    },
    errorText: {
      fontSize: 13,
      color: c.error,
      marginBottom: theme.spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.error,
      borderRadius: 10,
      padding: theme.spacing.sm,
    },
    inputLabel: {
      fontSize: 12,
      fontWeight: "600",
      color: c.secondaryText,
      marginBottom: theme.spacing.xs,
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    bankSelectBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: theme.borderRadius.input,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 15,
      marginBottom: theme.spacing.md,
    },
    bankSelectText: {
      fontSize: 16,
      color: c.primaryText,
      fontWeight: "500",
    },
    bankSelectPlaceholder: {
      fontSize: 16,
      color: c.secondaryText,
    },
    input: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: theme.borderRadius.input,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 15,
      fontSize: 16,
      color: c.primaryText,
      marginBottom: theme.spacing.md,
    },
    resolvedBox: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: theme.borderRadius.input,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 14,
      marginBottom: theme.spacing.lg,
      minHeight: 52,
      justifyContent: "center",
    },
    resolvedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    resolvedLabel: {
      fontSize: 14,
      color: c.secondaryText,
    },
    resolvedName: {
      fontSize: 15,
      fontWeight: "700",
      color: c.primaryText,
    },
    resolveError: {
      fontSize: 13,
      color: c.error,
    },
    resolvedHint: {
      fontSize: 14,
      color: c.secondaryText,
    },
    submitBtn: {
      backgroundColor: c.primaryAccent,
      borderRadius: theme.borderRadius.button,
      paddingVertical: 16,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 54,
    },
    submitBtnDisabled: {
      opacity: 0.5,
    },
    submitBtnText: {
      fontSize: 17,
      fontWeight: "700",
      color: c.buttonTextOnAccent,
    },
    pickerBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    pickerBox: {
      backgroundColor: c.primaryBackground,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      maxHeight: "70%",
      paddingBottom: theme.spacing.xl,
    },
    pickerHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    pickerTitle: {
      fontSize: 17,
      fontWeight: "700",
      color: c.primaryText,
    },
    pickerDone: {
      fontSize: 16,
      fontWeight: "600",
      color: c.primaryAccent,
    },
    pickerSearch: {
      margin: theme.spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: theme.borderRadius.input,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 12,
      fontSize: 15,
      color: c.primaryText,
    },
    pickerList: {
      flex: 1,
    },
    pickerItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 14,
    },
    pickerItemText: {
      fontSize: 16,
      color: c.primaryText,
      flex: 1,
    },
    pickerSep: {
      height: 1,
      backgroundColor: c.border,
      marginHorizontal: theme.spacing.lg,
    },
  });
}
