import { useState, useMemo } from 'react';
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
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '@/constants/theme';
import { type Colors } from '@/constants/colors';
import { useColors } from '@/store/appStore';
import { api } from '@/services/api';

type Step = 'email' | 'reset' | 'success';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const [step, setStep] = useState<Step>('email');
  const [focusedField, setFocusedField] = useState<string | null>(null);

  // Step 1
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [sendLoading, setSendLoading] = useState(false);
  const [sendApiError, setSendApiError] = useState('');

  // Step 2
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetApiError, setResetApiError] = useState('');

  const inputBorder = (field: string) =>
    focusedField === field ? c.primaryAccent : c.border;

  const handleSendCode = async () => {
    setEmailError('');
    setSendApiError('');
    if (!email.trim()) {
      setEmailError('Email is required');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError('Enter a valid email address');
      return;
    }
    setSendLoading(true);
    try {
      await api.post('/auth/forgot-password', { email: email.trim() });
      setStep('reset');
    } catch (err: unknown) {
      let message = 'Something went wrong. Please try again.';
      if (err && typeof err === 'object' && 'response' in err) {
        const res = (err as { response?: { data?: unknown; status?: number } }).response;
        const data = res?.data as Record<string, string> | undefined;
        message = data?.message || data?.error || data?.msg || message;
      }
      setSendApiError(message);
    } finally {
      setSendLoading(false);
    }
  };

  const handleResetPassword = async () => {
    setOtpError('');
    setPasswordError('');
    setConfirmError('');
    setResetApiError('');

    let valid = true;
    if (!otp.trim()) {
      setOtpError('OTP is required');
      valid = false;
    } else if (!/^\d{6}$/.test(otp.trim())) {
      setOtpError('Enter the 6-digit code');
      valid = false;
    }
    if (!newPassword) {
      setPasswordError('New password is required');
      valid = false;
    } else if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      valid = false;
    }
    if (!confirmPassword) {
      setConfirmError('Please confirm your password');
      valid = false;
    } else if (newPassword !== confirmPassword) {
      setConfirmError('Passwords do not match');
      valid = false;
    }
    if (!valid) return;

    setResetLoading(true);
    try {
      await api.post('/auth/reset-password', {
        email: email.trim(),
        otp: otp.trim(),
        password: newPassword,
      });
      setStep('success');
    } catch (err: unknown) {
      let message = 'Something went wrong. Please try again.';
      if (err && typeof err === 'object' && 'response' in err) {
        const res = (err as { response?: { data?: unknown; status?: number } }).response;
        const data = res?.data as Record<string, string> | undefined;
        message = data?.message || data?.error || data?.msg || message;
      }
      setResetApiError(message);
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={c.primaryText} />
          </Pressable>

          <Text style={styles.heading}>Reset Password</Text>

          {step === 'email' && (
            <>
              <Text style={styles.subtext}>
                Enter your account email and we'll send you a reset code.
              </Text>

              <View style={styles.form}>
                <View style={styles.field}>
                  <Text style={styles.label}>Email</Text>
                  <TextInput
                    placeholder="Enter your email"
                    placeholderTextColor={c.secondaryText}
                    value={email}
                    onChangeText={(v) => {
                      setEmail(v);
                      if (emailError) setEmailError('');
                    }}
                    onFocus={() => setFocusedField('email')}
                    onBlur={() => setFocusedField(null)}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.input, { borderColor: inputBorder('email') }]}
                    cursorColor={c.primaryAccent}
                    selectionColor={c.primaryAccent}
                    underlineColorAndroid="transparent"
                  />
                  {emailError ? <Text style={styles.inlineError}>{emailError}</Text> : null}
                </View>

                {sendApiError ? <Text style={styles.apiError}>{sendApiError}</Text> : null}

                <TouchableOpacity
                  activeOpacity={0.8}
                  style={[styles.submitBtn, sendLoading && styles.submitBtnDisabled]}
                  onPress={handleSendCode}
                  disabled={sendLoading}
                >
                  {sendLoading ? (
                    <ActivityIndicator color={c.buttonTextOnAccent} size="small" />
                  ) : (
                    <Text style={styles.submitBtnText}>Send Reset Code</Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          )}

          {step === 'reset' && (
            <>
              <Text style={styles.subtext}>
                Enter the code sent to <Text style={styles.subtextAccent}>{email}</Text> along with your new password.
              </Text>

              <View style={styles.form}>
                <View style={styles.field}>
                  <Text style={styles.label}>Reset Code (OTP)</Text>
                  <TextInput
                    placeholder="6-digit code"
                    placeholderTextColor={c.secondaryText}
                    value={otp}
                    onChangeText={(v) => {
                      setOtp(v.replace(/\D/g, '').slice(0, 6));
                      if (otpError) setOtpError('');
                    }}
                    onFocus={() => setFocusedField('otp')}
                    onBlur={() => setFocusedField(null)}
                    keyboardType="number-pad"
                    maxLength={6}
                    style={[styles.input, styles.otpInput, { borderColor: inputBorder('otp') }]}
                    cursorColor={c.primaryAccent}
                    selectionColor={c.primaryAccent}
                    underlineColorAndroid="transparent"
                  />
                  {otpError ? <Text style={styles.inlineError}>{otpError}</Text> : null}
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>New Password</Text>
                  <View style={[styles.inputRow, { borderColor: inputBorder('newPassword') }]}>
                    <TextInput
                      placeholder="At least 8 characters"
                      placeholderTextColor={c.secondaryText}
                      value={newPassword}
                      onChangeText={(v) => {
                        setNewPassword(v);
                        if (passwordError) setPasswordError('');
                      }}
                      onFocus={() => setFocusedField('newPassword')}
                      onBlur={() => setFocusedField(null)}
                      secureTextEntry={!showNewPassword}
                      style={styles.inputInner}
                      cursorColor={c.primaryAccent}
                      selectionColor={c.primaryAccent}
                      underlineColorAndroid="transparent"
                    />
                    <Pressable
                      onPress={() => setShowNewPassword((p) => !p)}
                      hitSlop={8}
                      style={styles.eyeBtn}
                    >
                      <Ionicons
                        name={showNewPassword ? 'eye-off-outline' : 'eye-outline'}
                        size={22}
                        color={c.secondaryText}
                      />
                    </Pressable>
                  </View>
                  {passwordError ? <Text style={styles.inlineError}>{passwordError}</Text> : null}
                </View>

                <View style={styles.field}>
                  <Text style={styles.label}>Confirm Password</Text>
                  <View style={[styles.inputRow, { borderColor: inputBorder('confirmPassword') }]}>
                    <TextInput
                      placeholder="Repeat new password"
                      placeholderTextColor={c.secondaryText}
                      value={confirmPassword}
                      onChangeText={(v) => {
                        setConfirmPassword(v);
                        if (confirmError) setConfirmError('');
                      }}
                      onFocus={() => setFocusedField('confirmPassword')}
                      onBlur={() => setFocusedField(null)}
                      secureTextEntry={!showConfirmPassword}
                      style={styles.inputInner}
                      cursorColor={c.primaryAccent}
                      selectionColor={c.primaryAccent}
                      underlineColorAndroid="transparent"
                    />
                    <Pressable
                      onPress={() => setShowConfirmPassword((p) => !p)}
                      hitSlop={8}
                      style={styles.eyeBtn}
                    >
                      <Ionicons
                        name={showConfirmPassword ? 'eye-off-outline' : 'eye-outline'}
                        size={22}
                        color={c.secondaryText}
                      />
                    </Pressable>
                  </View>
                  {confirmError ? <Text style={styles.inlineError}>{confirmError}</Text> : null}
                </View>

                {resetApiError ? <Text style={styles.apiError}>{resetApiError}</Text> : null}

                <TouchableOpacity
                  activeOpacity={0.8}
                  style={[styles.submitBtn, resetLoading && styles.submitBtnDisabled]}
                  onPress={handleResetPassword}
                  disabled={resetLoading}
                >
                  {resetLoading ? (
                    <ActivityIndicator color={c.buttonTextOnAccent} size="small" />
                  ) : (
                    <Text style={styles.submitBtnText}>Reset Password</Text>
                  )}
                </TouchableOpacity>

                <Pressable
                  onPress={() => setStep('email')}
                  style={styles.backLinkWrap}
                  hitSlop={12}
                >
                  <Text style={styles.backLink}>Didn't receive a code? Go back</Text>
                </Pressable>
              </View>
            </>
          )}

          {step === 'success' && (
            <View style={styles.successContainer}>
              <View style={styles.successIconWrap}>
                <Ionicons name="checkmark-circle" size={72} color={c.success} />
              </View>
              <Text style={styles.successTitle}>Password Reset!</Text>
              <Text style={styles.successText}>
                Your password has been updated successfully. You can now sign in with your new password.
              </Text>
              <TouchableOpacity
                activeOpacity={0.8}
                style={styles.submitBtn}
                onPress={() => router.replace('/login')}
              >
                <Text style={styles.submitBtnText}>Back to Login</Text>
              </TouchableOpacity>
            </View>
          )}
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
      alignSelf: 'flex-start',
      padding: theme.spacing.sm,
      marginBottom: theme.spacing.md,
    },
    heading: {
      fontSize: 26,
      fontWeight: '800',
      color: c.primaryText,
      marginBottom: theme.spacing.xs,
    },
    subtext: {
      fontSize: 14,
      color: c.secondaryText,
      marginBottom: theme.spacing.lg,
      lineHeight: 20,
    },
    subtextAccent: {
      color: c.primaryText,
      fontWeight: '600',
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
    otpInput: {
      fontSize: 24,
      fontWeight: '700',
      letterSpacing: 8,
      textAlign: 'center',
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderRadius: 12,
      paddingRight: 12,
      overflow: 'hidden',
    },
    inputInner: {
      flex: 1,
      backgroundColor: 'transparent',
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
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 52,
      marginTop: theme.spacing.lg,
    },
    submitBtnDisabled: {
      opacity: 0.8,
    },
    submitBtnText: {
      fontSize: 17,
      fontWeight: '700',
      color: c.buttonTextOnAccent,
    },
    backLinkWrap: {
      alignItems: 'center',
      marginTop: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    backLink: {
      fontSize: 13,
      fontWeight: '500',
      color: c.secondaryText,
    },
    successContainer: {
      alignItems: 'center',
      paddingTop: theme.spacing.xl,
    },
    successIconWrap: {
      marginBottom: theme.spacing.lg,
    },
    successTitle: {
      fontSize: 24,
      fontWeight: '800',
      color: c.primaryText,
      marginBottom: theme.spacing.sm,
    },
    successText: {
      fontSize: 15,
      color: c.secondaryText,
      textAlign: 'center',
      lineHeight: 22,
      maxWidth: 300,
      marginBottom: theme.spacing.xl,
    },
  });
}
