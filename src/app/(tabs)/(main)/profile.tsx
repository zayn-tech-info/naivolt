import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Image,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  FlatList,
  Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { theme } from "@/constants/theme";
import { Colors } from "@/constants/colors";
import { useColors, useAppStore } from "@/store/appStore";
import { api } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { config } from "@/constants/config";

interface UserProfile {
  _id: string;
  name: string;
  username?: string;
  email: string;
  phone?: string;
  profileImageUrl?: string;
  isVerified?: boolean;
  role?: string;
  createdAt?: string;
}

interface BankAccount {
  _id: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  bankCode?: string;
  isDefault: boolean;
}

interface ApiProfileResponse {
  status?: string;
  data?: UserProfile;
}

interface ApiBankAccountsResponse {
  status?: string;
  data?: BankAccount[];
}

interface ApiTransactionsResponse {
  status?: string;
  data?: { status: string }[];
}

interface BankOption {
  name: string;
  code: string;
}

interface ApiBanksResponse {
  status?: string;
  data?: BankOption[];
}

function formatMemberSince(createdAt?: string): string {
  if (!createdAt) return "Member since —";
  const d = new Date(createdAt);
  const month = d.toLocaleString("default", { month: "long" });
  const year = d.getFullYear();
  return `Member since ${month} ${year}`;
}

export default function ProfileScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { token, setUser } = useAuthStore();
  const c = useColors();
  const { mode, toggleMode } = useAppStore();
  const styles = useMemo(() => createStyles(c), [c]);

  const [refreshing, setRefreshing] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [addBankVisible, setAddBankVisible] = useState(false);
  const [editProfileVisible, setEditProfileVisible] = useState(false);
  const [changePasswordVisible, setChangePasswordVisible] = useState(false);
  const [bankActionAccount, setBankActionAccount] = useState<BankAccount | null>(null);

  const { data: profile, isLoading: profileLoading, refetch: refetchProfile } = useQuery({
    queryKey: ["profile"],
    queryFn: async () => {
      const res = await api.get<ApiProfileResponse>("/profile");
      return (res.data as ApiProfileResponse)?.data ?? null;
    },
  });

  const { data: bankAccounts = [], refetch: refetchBankAccounts } = useQuery({
    queryKey: ["bankAccounts"],
    queryFn: async () => {
      const res = await api.get<ApiBankAccountsResponse>("/bank-accounts");
      return (res.data as ApiBankAccountsResponse)?.data ?? [];
    },
  });

  const { data: transactionsRaw = [] } = useQuery({
    queryKey: ["transactions"],
    queryFn: async () => {
      const res = await api.get<ApiTransactionsResponse>("/transactions");
      const list = (res.data as ApiTransactionsResponse)?.data;
      return Array.isArray(list) ? list : [];
    },
  });

  const totalTransactions = transactionsRaw.length;
  const paidCount = transactionsRaw.filter((t: { status?: string }) => t.status === "paid").length;
  const pendingCount = transactionsRaw.filter((t: { status?: string }) => t.status === "pending").length;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refetchProfile(), refetchBankAccounts(), queryClient.invalidateQueries({ queryKey: ["transactions"] })]);
    } finally {
      setRefreshing(false);
    }
  }, [refetchProfile, refetchBankAccounts, queryClient]);

  const handlePickProfileImage = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Allow access to photos to change profile picture.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (result.canceled || !result.assets[0]) return;

      const uri = result.assets[0].uri;
      const filename = uri.split("/").pop() || "profile.jpg";
      const match = /\.(jpe?g|png|webp)$/i.exec(filename);
      const mime = match ? `image/${match[1].toLowerCase().replace("jpg", "jpeg")}` : "image/jpeg";

      setUploadingImage(true);
      const formData = new FormData();
      formData.append("profileImage", { uri, name: filename, type: mime } as unknown as Blob);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PATCH", `${config.apiUrl}/api/v1/profile/image`);
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            queryClient.invalidateQueries({ queryKey: ["profile"] });
            resolve();
          } else {
            let msg = "Failed to upload image.";
            try {
              const body = JSON.parse(xhr.responseText);
              msg = body?.message ?? msg;
            } catch {}
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error("Network error. Try again."));
        xhr.ontimeout = () => reject(new Error("Request timed out."));
        xhr.timeout = 30000;
        xhr.send(formData);
      });
    } catch (e) {
      Alert.alert("Error", (e as Error)?.message ?? "Failed to upload image.");
    } finally {
      setUploadingImage(false);
    }
  }, [token, queryClient]);

  const handleLogout = useCallback(() => {
    Alert.alert("Log Out", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log Out",
        style: "destructive",
        onPress: () => {
          useAuthStore.getState().logout();
          queryClient.clear();
          router.replace("/(auth)/welcome");
        },
      },
    ]);
  }, [queryClient, router]);

  const initials = profile?.name
    ? profile.name.trim().split(/\s+/).map((n) => n[0]).slice(0, 2).join("").toUpperCase()
    : "?";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primaryAccent} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Profile</Text>
          <TouchableOpacity onPress={() => Alert.alert("Settings", "Coming soon")} style={styles.settingsBtn} hitSlop={12}>
            <Ionicons name="settings-outline" size={24} color={c.primaryText} />
          </TouchableOpacity>
        </View>

        {/* Profile hero card */}
        <View style={styles.heroCard}>
          <View style={styles.avatarWrap}>
            {profileLoading ? (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <ActivityIndicator size="large" color={c.primaryBackground} />
              </View>
            ) : profile?.profileImageUrl ? (
              <Image source={{ uri: profile.profileImageUrl }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarInitials}>{initials}</Text>
              </View>
            )}
            {uploadingImage && (
              <View style={styles.avatarOverlay}>
                <ActivityIndicator size="large" color={c.primaryText} />
              </View>
            )}
            <TouchableOpacity style={styles.cameraBtn} onPress={handlePickProfileImage} disabled={uploadingImage}>
              <Ionicons name="camera" size={20} color={c.primaryBackground} />
            </TouchableOpacity>
          </View>
          {!profileLoading && profile && (
            <>
              <View style={styles.nameRow}>
                <Text style={styles.heroName}>{profile.name}</Text>
                {profile.isVerified && (
                  <View style={styles.verifiedBadge}>
                    <Ionicons name="checkmark-circle" size={18} color={c.primaryAccent} />
                  </View>
                )}
              </View>
              {profile.username != null && profile.username !== "" && (
                <Text style={styles.heroUsername}>@{profile.username}</Text>
              )}
              <Text style={styles.heroEmail}>{profile.email}</Text>
              <Text style={styles.memberSince}>{formatMemberSince(profile.createdAt)}</Text>
            </>
          )}
        </View>

        {/* Stats row */}
        <View style={styles.statsCard}>
          <View style={styles.statsRow}>
            <View style={styles.statPill}>
              <Text style={styles.statValue}>{profileLoading ? "—" : totalTransactions}</Text>
              <Text style={styles.statLabel}>Total</Text>
            </View>
            <View style={[styles.statPill, styles.statPillBorder]}>
              <Text style={styles.statValue}>{profileLoading ? "—" : paidCount}</Text>
              <Text style={styles.statLabel}>Paid</Text>
            </View>
            <View style={styles.statPill}>
              <Text style={[styles.statValue, { color: c.pending }]}>{profileLoading ? "—" : pendingCount}</Text>
              <Text style={styles.statLabel}>Pending</Text>
            </View>
          </View>
        </View>

        {/* Bank Account (single) */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Bank Account</Text>
            {bankAccounts.length === 0 && (
              <TouchableOpacity onPress={() => setAddBankVisible(true)}>
                <Text style={styles.addBankText}>Add</Text>
              </TouchableOpacity>
            )}
          </View>
          {bankAccounts.length === 0 ? (
            <View style={styles.emptyBank}>
              <Ionicons name="business-outline" size={48} color={c.secondaryText} />
              <Text style={styles.emptyBankText}>No bank account added</Text>
              <TouchableOpacity style={styles.addBankButton} onPress={() => setAddBankVisible(true)}>
                <Text style={styles.addBankButtonText}>Add Bank Account</Text>
              </TouchableOpacity>
            </View>
          ) : (
            bankAccounts.map((account) => (
              <Pressable
                key={account._id}
                style={styles.bankCard}
                onLongPress={() => setBankActionAccount(account)}
              >
                <View style={styles.bankCardContent}>
                  <Text style={styles.bankName}>{account.bankName}</Text>
                  <Text style={styles.bankAccountNumber}>{account.accountNumber}</Text>
                  <Text style={styles.bankAccountName}>{account.accountName}</Text>
                </View>
                {bankAccounts.length > 1 && account.isDefault && (
                  <View style={styles.defaultBadge}>
                    <Text style={styles.defaultBadgeText}>Default</Text>
                  </View>
                )}
              </Pressable>
            ))
          )}
        </View>

        {/* Account settings */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>ACCOUNT</Text>
          <View style={styles.menuCard}>
            <TouchableOpacity style={styles.menuRow} onPress={() => setEditProfileVisible(true)}>
              <Ionicons name="person-outline" size={22} color={c.secondaryText} />
              <Text style={styles.menuLabel}>Edit Profile</Text>
              <Ionicons name="chevron-forward" size={20} color={c.secondaryText} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuRow} onPress={() => setChangePasswordVisible(true)}>
              <Ionicons name="lock-closed-outline" size={22} color={c.secondaryText} />
              <Text style={styles.menuLabel}>Change Password</Text>
              <Ionicons name="chevron-forward" size={20} color={c.secondaryText} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuRow} onPress={() => Alert.alert("Coming soon", "Notifications")}>
              <Ionicons name="notifications-outline" size={22} color={c.secondaryText} />
              <Text style={styles.menuLabel}>Notifications</Text>
              <Ionicons name="chevron-forward" size={20} color={c.secondaryText} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuRow} onPress={() => Alert.alert("Coming soon", "Privacy & Security")}>
              <Ionicons name="shield-checkmark-outline" size={22} color={c.secondaryText} />
              <Text style={styles.menuLabel}>Privacy & Security</Text>
              <Ionicons name="chevron-forward" size={20} color={c.secondaryText} />
            </TouchableOpacity>
            <View style={styles.menuRow}>
              <Ionicons name={mode === "dark" ? "moon-outline" : "sunny-outline"} size={22} color={c.secondaryText} />
              <Text style={styles.menuLabel}>Dark Mode</Text>
              <Switch
                value={mode === "dark"}
                onValueChange={toggleMode}
                trackColor={{ false: c.border, true: c.primaryAccent }}
                thumbColor={mode === "dark" ? c.buttonTextOnAccent : c.surface}
              />
            </View>
            <TouchableOpacity style={[styles.menuRow, styles.menuRowLast]} onPress={() => Alert.alert("Coming soon", "Help & Support")}>
              <Ionicons name="help-circle-outline" size={22} color={c.secondaryText} />
              <Text style={styles.menuLabel}>Help & Support</Text>
              <Ionicons name="chevron-forward" size={20} color={c.secondaryText} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Danger zone */}
        <TouchableOpacity style={styles.logoutRow} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={22} color={c.error} />
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Add Bank Account Modal */}
      <AddBankAccountModal
        visible={addBankVisible}
        onClose={() => setAddBankVisible(false)}
        onSuccess={() => {
          setAddBankVisible(false);
          queryClient.invalidateQueries({ queryKey: ["bankAccounts"] });
          Alert.alert("Success", "Bank account added.");
        }}
      />

      {/* Edit Profile Modal */}
      <EditProfileModal
        visible={editProfileVisible}
        profile={profile ?? undefined}
        onClose={() => setEditProfileVisible(false)}
        onSuccess={(updated) => {
          setEditProfileVisible(false);
          queryClient.invalidateQueries({ queryKey: ["profile"] });
          setUser(updated);
        }}
      />

      {/* Change Password Modal */}
      <ChangePasswordModal
        visible={changePasswordVisible}
        onClose={() => setChangePasswordVisible(false)}
        onSuccess={() => {
          setChangePasswordVisible(false);
          Alert.alert("Success", "Password changed successfully");
        }}
      />

      {/* Bank account action sheet (single account: Delete only) */}
      <Modal visible={!!bankActionAccount} transparent animationType="slide">
        <Pressable style={styles.actionSheetBackdrop} onPress={() => setBankActionAccount(null)}>
          <View style={styles.actionSheetBox}>
            {bankAccounts.length > 1 && (
              <TouchableOpacity
                style={styles.actionSheetOption}
                onPress={async () => {
                  if (!bankActionAccount) return;
                  try {
                    await api.patch(`/bank-accounts/${bankActionAccount._id}/set-default`);
                    queryClient.invalidateQueries({ queryKey: ["bankAccounts"] });
                    setBankActionAccount(null);
                  } catch {
                    Alert.alert("Error", "Could not set default.");
                  }
                }}
              >
                <Text style={styles.actionSheetOptionText}>Set as Default</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.actionSheetOption, styles.actionSheetOptionDanger]}
              onPress={() => {
                if (!bankActionAccount) return;
                Alert.alert("Delete account", "Remove this bank account?", [
                  { text: "Cancel", style: "cancel", onPress: () => setBankActionAccount(null) },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: async () => {
                      try {
                        await api.delete(`/bank-accounts/${bankActionAccount._id}`);
                        queryClient.invalidateQueries({ queryKey: ["bankAccounts"] });
                        setBankActionAccount(null);
                      } catch {
                        Alert.alert("Error", "Could not delete account.");
                      }
                    },
                  },
                ]);
              }}
            >
              <Text style={styles.actionSheetOptionTextDanger}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionSheetCancel} onPress={() => setBankActionAccount(null)}>
              <Text style={styles.actionSheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function AddBankAccountModal({
  visible,
  onClose,
  onSuccess,
}: {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
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
    enabled: visible,
  });

  const filteredBanks = useMemo(() => {
    const banks = banksData ?? [];
    if (!bankSearch.trim()) return banks;
    const q = bankSearch.trim().toLowerCase();
    return banks.filter((b) => b.name.toLowerCase().includes(q));
  }, [banksData, bankSearch]);

  useEffect(() => {
    if (!visible) {
      setSelectedBank(null);
      setAccountNumber("");
      setResolvedAccountName("");
      setResolveError("");
      setError("");
      setBankSearch("");
    }
  }, [visible]);

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
      .get<{ status?: string; data?: { account_name: string } }>(
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
        const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Could not verify account number.";
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
      setError("Verify your account number first — account name will appear above");
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
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to add bank account.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (!visible) return null;
  return (
    <>
      <Modal visible animationType="slide">
        <SafeAreaView style={styles.modalSafe}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalKav}>
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={onClose}>
                <Text style={styles.modalCloseText}>Cancel</Text>
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Add Bank Account</Text>
              <View style={styles.modalHeaderRight} />
            </View>
            <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
              {error ? <Text style={styles.modalError}>{error}</Text> : null}
              <Text style={styles.inputLabel}>Bank</Text>
              <TouchableOpacity style={styles.bankSelectBtn} onPress={() => setBankPickerVisible(true)}>
                <Text style={selectedBank ? styles.bankSelectText : styles.bankSelectPlaceholder}>
                  {selectedBank ? selectedBank.name : "Select bank"}
                </Text>
                <Ionicons name="chevron-down" size={20} color={c.secondaryText} />
              </TouchableOpacity>
              <Text style={styles.inputLabel}>Account Number</Text>
              <TextInput
                style={styles.input}
                value={accountNumber}
                onChangeText={(t) => setAccountNumber(t.replace(/\D/g, "").slice(0, 10))}
                placeholder="10 digits"
                placeholderTextColor={c.secondaryText}
                keyboardType="number-pad"
                maxLength={10}
              />
              <Text style={styles.inputLabel}>Account Name</Text>
              {resolving ? (
                <View style={styles.resolvedRow}>
                  <ActivityIndicator size="small" color={c.primaryAccent} />
                  <Text style={styles.resolvedLabel}>Verifying…</Text>
                </View>
              ) : resolveError ? (
                <Text style={styles.resolveError}>{resolveError}</Text>
              ) : resolvedAccountName ? (
                <View style={styles.resolvedRow}>
                  <Ionicons name="checkmark-circle" size={20} color={c.primaryAccent} />
                  <Text style={styles.resolvedName}>{resolvedAccountName}</Text>
                </View>
              ) : (
                <Text style={styles.resolvedHint}>Enter your 10-digit account number to verify</Text>
              )}
              <TouchableOpacity
                style={[styles.submitBtn, (loading || resolving || !resolvedAccountName) && styles.submitBtnDisabled]}
                onPress={submit}
                disabled={loading || resolving || !resolvedAccountName}
              >
                {loading ? <ActivityIndicator color={c.primaryBackground} /> : <Text style={styles.submitBtnText}>Add Account</Text>}
              </TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      <Modal visible={bankPickerVisible} transparent animationType="slide">
        <View style={styles.pickerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setBankPickerVisible(false)} />
          <View style={styles.pickerBox}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Select bank</Text>
              <TouchableOpacity onPress={() => setBankPickerVisible(false)}>
                <Text style={styles.modalCloseText}>Done</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.pickerSearch}
              value={bankSearch}
              onChangeText={setBankSearch}
              placeholder="Search banks..."
              placeholderTextColor={c.secondaryText}
            />
            <FlatList
              data={filteredBanks}
              keyExtractor={(item) => `${item.code}-${item.name}`}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.pickerItem}
                  onPress={() => {
                    setSelectedBank(item);
                    setBankPickerVisible(false);
                  }}
                >
                  <Text style={styles.pickerItemText}>{item.name}</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={styles.pickerEmpty}>No banks found</Text>}
              style={styles.pickerList}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

function EditProfileModal({
  visible,
  profile,
  onClose,
  onSuccess,
}: {
  visible: boolean;
  profile?: UserProfile | null;
  onClose: () => void;
  onSuccess: (user: UserProfile) => void;
}) {
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [name, setName] = useState(profile?.name ?? "");
  const [username, setUsername] = useState(profile?.username ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (visible && profile) {
      setName(profile.name ?? "");
      setUsername(profile.username ?? "");
      setPhone(profile.phone ?? "");
      setError("");
    }
  }, [visible, profile]);

  const submit = async () => {
    setError("");
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setLoading(true);
    try {
      const res = await api.patch<ApiProfileResponse>("/profile", {
        name: name.trim(),
        username: username.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      const data = (res.data as ApiProfileResponse)?.data;
      if (data) onSuccess(data);
      else onClose();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to update profile.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (!visible) return null;
  return (
    <Modal visible animationType="slide">
      <SafeAreaView style={styles.modalSafe}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalKav}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Edit Profile</Text>
            <View style={styles.modalHeaderRight} />
          </View>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
            {error ? <Text style={styles.modalError}>{error}</Text> : null}
            <Text style={styles.inputLabel}>Full Name</Text>
            <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={c.secondaryText} />
            <Text style={styles.inputLabel}>Username</Text>
            <TextInput style={styles.input} value={username} onChangeText={setUsername} placeholder="username" placeholderTextColor={c.secondaryText} autoCapitalize="none" />
            <Text style={styles.inputLabel}>Email</Text>
            <View style={styles.emailRow}>
              <TextInput style={[styles.input, styles.inputDisabled, styles.emailInput]} value={profile?.email ?? ""} editable={false} placeholderTextColor={c.secondaryText} />
              <Ionicons name="lock-closed" size={20} color={c.secondaryText} style={styles.emailLock} />
            </View>
            <Text style={styles.inputLabel}>Phone</Text>
            <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="08012345678" placeholderTextColor={c.secondaryText} keyboardType="phone-pad" />
            <TouchableOpacity style={[styles.submitBtn, loading && styles.submitBtnDisabled]} onPress={submit} disabled={loading}>
              {loading ? <ActivityIndicator color={c.primaryBackground} /> : <Text style={styles.submitBtnText}>Save</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function ChangePasswordModal({ visible, onClose, onSuccess }: { visible: boolean; onClose: () => void; onSuccess: () => void }) {
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setError("");
    }
  }, [visible]);

  const submit = async () => {
    setError("");
    if (!currentPassword) {
      setError("Current password is required");
      return;
    }
    if (newPassword.length < 6) {
      setError("New password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match");
      return;
    }
    setLoading(true);
    try {
      await api.patch("/profile/password", {
        currentPassword,
        newPassword,
        confirmNewPassword: confirmPassword,
      });
      onSuccess();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Failed to change password.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (!visible) return null;
  return (
    <Modal visible animationType="slide">
      <SafeAreaView style={styles.modalSafe}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalKav}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Change Password</Text>
            <View style={styles.modalHeaderRight} />
          </View>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
            {error ? <Text style={styles.modalError}>{error}</Text> : null}
            <Text style={styles.inputLabel}>Current Password</Text>
            <View style={styles.passwordWrap}>
              <TextInput
                style={styles.inputFlex}
                value={currentPassword}
                onChangeText={setCurrentPassword}
                placeholder="Current password"
                placeholderTextColor={c.secondaryText}
                secureTextEntry={!showCurrent}
              />
              <TouchableOpacity onPress={() => setShowCurrent((s) => !s)} style={styles.eyeBtn}>
                <Ionicons name={showCurrent ? "eye-off-outline" : "eye-outline"} size={22} color={c.secondaryText} />
              </TouchableOpacity>
            </View>
            <Text style={styles.inputLabel}>New Password</Text>
            <View style={styles.passwordWrap}>
              <TextInput
                style={styles.inputFlex}
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder="At least 6 characters"
                placeholderTextColor={c.secondaryText}
                secureTextEntry={!showNew}
              />
              <TouchableOpacity onPress={() => setShowNew((s) => !s)} style={styles.eyeBtn}>
                <Ionicons name={showNew ? "eye-off-outline" : "eye-outline"} size={22} color={c.secondaryText} />
              </TouchableOpacity>
            </View>
            <Text style={styles.inputLabel}>Confirm New Password</Text>
            <View style={styles.passwordWrap}>
              <TextInput
                style={styles.inputFlex}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                placeholder="Confirm new password"
                placeholderTextColor={c.secondaryText}
                secureTextEntry={!showConfirm}
              />
              <TouchableOpacity onPress={() => setShowConfirm((s) => !s)} style={styles.eyeBtn}>
                <Ionicons name={showConfirm ? "eye-off-outline" : "eye-outline"} size={22} color={c.secondaryText} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={[styles.submitBtn, loading && styles.submitBtnDisabled]} onPress={submit} disabled={loading}>
              {loading ? <ActivityIndicator color={c.primaryBackground} /> : <Text style={styles.submitBtnText}>Change Password</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function createStyles(c: Colors) {
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.primaryBackground },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: theme.spacing.lg, paddingBottom: 100 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing.md,
  },
  headerTitle: { fontSize: 28, fontWeight: "800", color: c.primaryText },
  settingsBtn: { padding: 4 },
  heroCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 20,
    padding: theme.spacing.lg,
    alignItems: "center",
    marginBottom: theme.spacing.md,
  },
  avatarWrap: { position: "relative", marginBottom: theme.spacing.md },
  avatar: { width: 72, height: 72, borderRadius: 36 },
  avatarPlaceholder: { backgroundColor: c.primaryAccent, justifyContent: "center", alignItems: "center" },
  avatarInitials: { fontSize: 24, fontWeight: "700", color: c.primaryBackground },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 36,
    width: 72,
    height: 72,
    justifyContent: "center",
    alignItems: "center",
  },
  cameraBtn: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.primaryAccent,
    justifyContent: "center",
    alignItems: "center",
  },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  heroName: { fontSize: 20, fontWeight: "700", color: c.primaryText },
  verifiedBadge: {},
  heroUsername: { fontSize: 14, color: c.secondaryText, marginTop: 2 },
  heroEmail: { fontSize: 13, color: c.secondaryText, marginTop: 2 },
  memberSince: { fontSize: 13, color: c.secondaryText, marginTop: 4 },
  statsCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 20,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.lg,
  },
  statsRow: { flexDirection: "row" },
  statPill: { flex: 1, alignItems: "center", paddingVertical: 8 },
  statPillBorder: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: c.border },
  statValue: { fontSize: 18, fontWeight: "700", color: c.primaryText },
  statLabel: { fontSize: 12, color: c.secondaryText, marginTop: 2 },
  section: { marginBottom: theme.spacing.lg },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: c.secondaryText,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 10,
  },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: c.primaryText },
  addBankText: { color: c.primaryAccent, fontWeight: "700", fontSize: 16 },
  emptyBank: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 20, padding: theme.spacing.xl, alignItems: "center" },
  emptyBankText: { color: c.secondaryText, marginTop: 8, marginBottom: 12 },
  addBankButton: { backgroundColor: c.primaryAccent, paddingVertical: 12, paddingHorizontal: 24, borderRadius: theme.borderRadius.button },
  addBankButtonText: { color: c.primaryBackground, fontWeight: "700" },
  bankCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 20,
    padding: theme.spacing.md,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bankCardContent: { flex: 1 },
  bankName: { fontSize: 16, fontWeight: "700", color: c.primaryText },
  bankAccountNumber: { fontSize: 14, color: c.secondaryText, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", marginTop: 2 },
  bankAccountName: { fontSize: 13, color: c.secondaryText, marginTop: 2 },
  defaultBadge: { backgroundColor: c.primaryAccent, paddingHorizontal: 8, paddingVertical: 4, borderRadius: theme.borderRadius.badge },
  defaultBadgeText: { fontSize: 11, fontWeight: "700", color: c.primaryBackground },
  menuCard: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 20, overflow: "hidden" },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 56,
    borderBottomWidth: 1,
    borderColor: c.border,
    paddingHorizontal: theme.spacing.md,
    gap: 12,
  },
  menuRowLast: { borderBottomWidth: 0 },
  menuLabel: { flex: 1, fontSize: 16, color: c.primaryText },
  logoutRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    marginTop: 8,
    backgroundColor: "rgba(255,68,68,0.1)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,68,68,0.3)",
  },
  logoutText: { fontSize: 16, fontWeight: "600", color: c.error },
  modalSafe: { flex: 1, backgroundColor: c.primaryBackground },
  modalKav: { flex: 1 },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: theme.spacing.md, paddingVertical: 12, borderBottomWidth: 1, borderColor: c.border },
  modalCloseText: { color: c.primaryAccent, fontSize: 16 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: c.primaryText },
  modalHeaderRight: { width: 60 },
  modalScroll: { flex: 1 },
  modalScrollContent: { padding: theme.spacing.lg, paddingBottom: 40 },
  modalError: { color: c.error, marginBottom: 12 },
  inputLabel: { fontSize: 14, color: c.secondaryText, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: theme.borderRadius.input, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: c.primaryText },
  inputDisabled: { opacity: 0.7 },
  emailRow: { position: "relative" },
  emailInput: { paddingRight: 44 },
  emailLock: { position: "absolute", right: 14, top: 14 },
  passwordWrap: { flexDirection: "row", alignItems: "center", backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: theme.borderRadius.input, marginBottom: 4 },
  inputFlex: { flex: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: c.primaryText },
  eyeBtn: { padding: 12 },
  submitBtn: { backgroundColor: c.primaryAccent, borderRadius: theme.borderRadius.button, paddingVertical: 14, marginTop: 24, alignItems: "center", justifyContent: "center", minHeight: 48 },
  submitBtnDisabled: { opacity: 0.7 },
  submitBtnText: { fontSize: 16, fontWeight: "700", color: c.primaryBackground },
  bankSelectBtn: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: theme.borderRadius.input, paddingHorizontal: 14, paddingVertical: 12 },
  bankSelectText: { fontSize: 16, color: c.primaryText },
  bankSelectPlaceholder: { fontSize: 16, color: c.secondaryText },
  resolvedRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 4 },
  resolvedLabel: { fontSize: 14, color: c.secondaryText },
  resolvedName: { fontSize: 16, color: c.primaryText, fontWeight: "600", flex: 1 },
  resolveError: { fontSize: 14, color: c.error, marginTop: 4 },
  resolvedHint: { fontSize: 14, color: c.secondaryText, marginTop: 4 },
  pickerBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  pickerBox: { backgroundColor: c.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "80%", paddingBottom: 40 },
  pickerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: theme.spacing.md, paddingVertical: 12, borderBottomWidth: 1, borderColor: c.border },
  pickerTitle: { fontSize: 18, fontWeight: "700", color: c.primaryText },
  pickerSearch: { margin: theme.spacing.md, backgroundColor: c.primaryBackground, borderWidth: 1, borderColor: c.border, borderRadius: theme.borderRadius.input, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: c.primaryText },
  pickerList: { maxHeight: 400 },
  pickerItem: { paddingVertical: 14, paddingHorizontal: theme.spacing.md, borderBottomWidth: 1, borderColor: c.border },
  pickerItemText: { fontSize: 16, color: c.primaryText },
  pickerEmpty: { padding: theme.spacing.lg, textAlign: "center", color: c.secondaryText },
  actionSheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  actionSheetBox: { backgroundColor: c.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: theme.spacing.md, paddingBottom: 40 },
  actionSheetOption: { paddingVertical: 16, alignItems: "center" },
  actionSheetOptionText: { fontSize: 16, color: c.primaryText },
  actionSheetOptionDanger: {},
  actionSheetOptionTextDanger: { fontSize: 16, color: c.error, fontWeight: "600" },
  actionSheetCancel: { paddingVertical: 16, alignItems: "center", marginTop: 8 },
  actionSheetCancelText: { fontSize: 16, color: c.secondaryText },
  });
}
