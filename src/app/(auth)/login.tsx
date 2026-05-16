import { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useForm, Controller } from "react-hook-form";
import { Ionicons } from "@expo/vector-icons";
import { setToken as setTokenInStorage, saveUser, TOKEN_KEY } from "@/services/tokenStorage";
import { theme } from "@/constants/theme";
import { type Colors } from "@/constants/colors";
import { useColors } from "@/store/appStore";
import { api } from "@/services/api";
import { useAuthStore } from "@/store/authStore";

interface LoginForm {
  email: string;
  password: string;
}

export default function LoginScreen() {
  const router = useRouter();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const { setUser, setToken } = useAuthStore();
  const [showPassword, setShowPassword] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const onSubmit = async (data: LoginForm) => {
    setApiError(null);
    if (!data.email?.trim()) {
      setError("email", { message: "Email is required" });
      return;
    }
    if (!data.password) {
      setError("password", { message: "Password is required" });
      return;
    }

    try {
      const res = await api.post<{
        token: string;
        user: {
          _id?: string;
          id?: string;
          name: string;
          username?: string;
          email: string;
          phone?: string;
          role?: string;
        };
      }>("/auth/login", {
        email: data.email.trim(),
        password: data.password,
      });
      const { token, user } = res.data;
      if (token && user) {
        try {
          await setTokenInStorage(TOKEN_KEY, token);
        } catch {
          // Storage failed; token may be in memory only
        }
        const userPayload = {
          _id: user._id ?? user.id,
          name: user.name,
          username: user.username,
          email: user.email,
          phone: user.phone,
          role: user.role as "user" | "admin" | undefined,
        };
        setToken(token);
        setUser(userPayload);
        await saveUser(userPayload);
        if (user.role === "admin") {
          router.replace("/(admin)/dashboard");
        } else {
          router.replace("/(tabs)");
        }
      }
    } catch (err: unknown) {
      let message = "Something went wrong. Please try again.";
      if (err && typeof err === "object" && "response" in err) {
        const res = (err as { response?: { data?: unknown; status?: number } })
          .response;
        const data = res?.data as Record<string, string> | undefined;
        message =
          data?.message ||
          data?.error ||
          data?.msg ||
          (res?.status === 401 ? "Invalid email or password" : message);
      } else if (
        err &&
        typeof err === "object" &&
        "message" in err &&
        typeof (err as Error).message === "string"
      ) {
        const msg = (err as Error).message;
        if (msg.includes("timeout") || msg.includes("ECONNABORTED"))
          message =
            "Request timed out. Check your connection and that the backend is running.";
        else if (msg.includes("Network Error") || msg.includes("ECONNREFUSED"))
          message =
            "Cannot connect to server. Is the backend running? On Android emulator set EXPO_PUBLIC_API_URL=http://10.0.2.2:5000.";
        else message = msg;
      }
      setApiError(message);
    }
  };

  const inputBorder = (fieldName: string) =>
    focusedField === fieldName ? c.primaryAccent : c.border;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            onPress={() => router.back()}
            style={styles.backBtn}
            hitSlop={12}
          >
            <Ionicons name="arrow-back" size={24} color={c.primaryText} />
          </Pressable>

          <Text style={styles.heading}>Welcome back</Text>
          <Text style={styles.subtext}>
            Sign in to your Naivolt account
          </Text>

          <View style={styles.form}>
            <Controller
              control={control}
              name="email"
              render={({ field }) => (
                <View style={styles.field}>
                  <Text style={styles.label}>Email</Text>
                  <TextInput
                    placeholder="Enter your email"
                    placeholderTextColor={c.secondaryText}
                    value={field.value}
                    onChangeText={field.onChange}
                    onBlur={() => {
                      field.onBlur();
                      setFocusedField(null);
                    }}
                    onFocus={() => setFocusedField("email")}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[
                      styles.input,
                      { borderColor: inputBorder("email") },
                    ]}
                    cursorColor={c.primaryAccent}
                    selectionColor={c.primaryAccent}
                    underlineColorAndroid="transparent"
                  />
                  {errors.email ? (
                    <Text style={styles.inlineError}>
                      {errors.email.message}
                    </Text>
                  ) : null}
                </View>
              )}
            />

            <Controller
              control={control}
              name="password"
              render={({ field }) => (
                <View style={styles.field}>
                  <Text style={styles.label}>Password</Text>
                  <View
                    style={[
                      styles.inputRow,
                      { borderColor: inputBorder("password") },
                    ]}
                  >
                    <TextInput
                      placeholder="Enter your password"
                      placeholderTextColor={c.secondaryText}
                      value={field.value}
                      onChangeText={field.onChange}
                      onBlur={() => {
                        field.onBlur();
                        setFocusedField(null);
                      }}
                      onFocus={() => setFocusedField("password")}
                      secureTextEntry={!showPassword}
                      style={styles.inputInner}
                      cursorColor={c.primaryAccent}
                      selectionColor={c.primaryAccent}
                      underlineColorAndroid="transparent"
                    />
                    <Pressable
                      onPress={() => setShowPassword((p) => !p)}
                      hitSlop={8}
                      style={styles.eyeBtn}
                    >
                      <Ionicons
                        name={
                          showPassword ? "eye-off-outline" : "eye-outline"
                        }
                        size={22}
                        color={c.secondaryText}
                      />
                    </Pressable>
                  </View>
                  {errors.password ? (
                    <Text style={styles.inlineError}>
                      {errors.password.message}
                    </Text>
                  ) : null}
                </View>
              )}
            />

            <View style={styles.forgotRow}>
              <Pressable onPress={() => router.push('/forgot-password')} hitSlop={12}>
                <Text style={styles.forgotLink}>Forgot password?</Text>
              </Pressable>
            </View>

            {apiError ? (
              <Text style={styles.apiError}>{apiError}</Text>
            ) : null}

            <TouchableOpacity
              activeOpacity={0.8}
              style={[styles.submitBtn, isSubmitting && styles.submitBtnDisabled]}
              onPress={handleSubmit(onSubmit)}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator
                  color={c.buttonTextOnAccent}
                  size="small"
                />
              ) : (
                <Text style={styles.submitBtnText}>Sign in</Text>
              )}
            </TouchableOpacity>

            <View style={styles.signupRow}>
              <Text style={styles.signupPrompt}>{"Don't have an account?"}</Text>
              <Pressable
                onPress={() => router.push("/register")}
                style={({ pressed }) => [
                  styles.signupLinkTouch,
                  pressed && { opacity: 0.8 },
                ]}
                hitSlop={{ top: 16, bottom: 16, left: 12, right: 12 }}
              >
                <Text style={styles.signupLink}>Sign up</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(c: Colors) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: c.primaryBackground,
    },
    keyboard: {
      flex: 1,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.xl,
    },
    backBtn: {
      alignSelf: "flex-start",
      padding: theme.spacing.sm,
      marginBottom: theme.spacing.md,
    },
    heading: {
      fontSize: 26,
      fontWeight: "800",
      color: c.primaryText,
      marginBottom: theme.spacing.xs,
    },
    subtext: {
      fontSize: 14,
      color: c.secondaryText,
      marginBottom: theme.spacing.lg,
    },
    form: {
      marginBottom: theme.spacing.lg,
    },
    field: {
      marginBottom: theme.spacing.md,
    },
    label: {
      fontSize: 12,
      color: c.secondaryText,
      marginBottom: theme.spacing.xs,
    },
    input: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderRadius: 12,
      color: c.primaryText,
      fontSize: 16,
      padding: 16,
    },
    inputRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderRadius: 12,
      paddingRight: 12,
      overflow: "hidden",
    },
    inputInner: {
      flex: 1,
      backgroundColor: "transparent",
      borderWidth: 0,
      color: c.primaryText,
      fontSize: 16,
      paddingVertical: 16,
      paddingHorizontal: 16,
      minHeight: 52,
    },
    eyeBtn: {
      padding: 4,
    },
    inlineError: {
      fontSize: 12,
      color: c.error,
      marginTop: theme.spacing.xs,
    },
    apiError: {
      fontSize: 12,
      color: c.error,
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
    },
    submitBtn: {
      backgroundColor: c.primaryAccent,
      paddingVertical: 16,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 52,
      marginTop: theme.spacing.lg,
    },
    submitBtnDisabled: {
      opacity: 0.8,
    },
    submitBtnText: {
      fontSize: 17,
      fontWeight: "700",
      color: c.buttonTextOnAccent,
    },
    signupRow: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: 8,
      marginTop: theme.spacing.lg,
      minHeight: 48,
    },
    signupPrompt: {
      fontSize: 16,
      color: c.secondaryText,
    },
    signupLinkTouch: {
      paddingVertical: 12,
      paddingHorizontal: 16,
    },
    signupLink: {
      fontSize: 17,
      fontWeight: "700",
      color: c.primaryAccent,
    },
    forgotRow: {
      alignItems: "flex-end",
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.sm,
    },
    forgotLink: {
      fontSize: 13,
      fontWeight: "600",
      color: c.primaryAccent,
    },
  });
}
