import { colors } from '@/constants/colors';
import { config } from '@/constants/config';
import { api } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import { formatCurrency } from '@/utils/formatCurrency';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface CountryRate {
  code: string;
  name: string;
  currency: string;
  ratePerUnit: number;
}

interface GiftCardCategory {
  _id: string;
  name: string;
  slug: string;
  emoji: string;
  countries: CountryRate[];
}

interface CategoriesResponse {
  data?: GiftCardCategory[];
}

const DENOMINATIONS = [10, 25, 50, 100, 200, 500];

export default function GiftCardsScreen() {
  const router = useRouter();
  const [step, setStep] = useState<'select' | 'details'>('select');
  const [selectedCategory, setSelectedCategory] = useState<GiftCardCategory | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<CountryRate | null>(null);
  const [denomination, setDenomination] = useState('');
  const [cardCode, setCardCode] = useState('');
  const [cardPin, setCardPin] = useState('');
  const [proofImage, setProofImage] = useState<{ uri: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);

  const { data: categoriesData, isLoading, isError } = useQuery({
    queryKey: ['giftCardCategories'],
    queryFn: async () => {
      const res = await api.get<CategoriesResponse>('/gift-cards/categories');
      return res.data?.data ?? [];
    },
  });

  const categories = categoriesData ?? [];

  const denomNum = useMemo(() => parseFloat(denomination) || 0, [denomination]);
  const nairaAmount = useMemo(() => {
    if (!selectedCountry || denomNum <= 0) return 0;
    return Math.round(denomNum * selectedCountry.ratePerUnit);
  }, [selectedCountry, denomNum]);

  const canSubmit = !!selectedCategory && !!selectedCountry && denomNum > 0 && cardCode.trim().length > 0 && !!proofImage;

  const handleSelectCategory = (cat: GiftCardCategory) => {
    setSelectedCategory(cat);
    setSelectedCountry(cat.countries.length === 1 ? cat.countries[0] : null);
    setStep('details');
  };

  const handleBack = () => {
    if (step === 'details') {
      setStep('select');
      setSelectedCategory(null);
      setSelectedCountry(null);
      setDenomination('');
      setCardCode('');
      setCardPin('');
      setProofImage(null);
      setSubmitError('');
    } else {
      router.back();
    }
  };

  const pickImage = async () => {
    try {
      const ImagePicker = await import('expo-image-picker');
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Allow access to your photos to upload a screenshot.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        setProofImage({ uri: result.assets[0].uri });
      }
    } catch {
      Alert.alert('Error', 'Could not open photo library.');
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) return;
    setSubmitError('');
    setIsSubmitting(true);

    try {
      const token = useAuthStore.getState().token;

      const formData = new FormData();
      formData.append('categoryId', selectedCategory!._id);
      formData.append('country', selectedCountry!.code);
      formData.append('denomination', String(denomNum));
      formData.append('cardCode', cardCode.trim());
      if (cardPin.trim()) formData.append('cardPin', cardPin.trim());

      if (proofImage?.uri) {
        const filename = proofImage.uri.split('/').pop() || 'proof.jpg';
        const match = /\.(jpe?g|png|webp)$/i.exec(filename);
        const mime = match ? `image/${match[1].toLowerCase()}` : 'image/jpeg';
        formData.append('proofImage', { uri: proofImage.uri, name: filename, type: mime } as unknown as Blob);
      }

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${config.apiUrl}/api/v1/gift-cards/transactions`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            let msg = 'Submission failed. Please try again.';
            try { msg = JSON.parse(xhr.responseText)?.message ?? msg; } catch {}
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error(`Cannot reach server (${config.apiUrl})`));
        xhr.ontimeout = () => reject(new Error('Request timed out.'));
        xhr.timeout = 30000;
        xhr.send(formData);
      });

      setShowSuccess(true);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setSubmitError(e?.message ?? 'Failed to submit. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={handleBack} hitSlop={12} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={22} color={colors.primaryText} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>
              {step === 'select' ? 'Sell Gift Cards' : selectedCategory?.name ?? 'Gift Card'}
            </Text>
            <Text style={styles.headerSub}>
              {step === 'select' ? 'Select a card type to sell' : 'Enter card details'}
            </Text>
          </View>
        </View>

        {step === 'select' ? (
          /* ── STEP 1: Category grid ───────────────────────────────────── */
          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {isLoading ? (
              <View style={styles.centered}>
                <ActivityIndicator size="large" color={colors.primaryAccent} />
                <Text style={styles.loadingText}>Loading categories…</Text>
              </View>
            ) : isError || categories.length === 0 ? (
              <View style={styles.centered}>
                <Ionicons name="alert-circle-outline" size={40} color={colors.error} />
                <Text style={styles.errorText}>Could not load gift card types.</Text>
              </View>
            ) : (
              <>
                <Text style={styles.sectionLabel}>Available cards</Text>
                <View style={styles.grid}>
                  {categories.map((cat) => (
                    <TouchableOpacity
                      key={cat._id}
                      style={styles.categoryCard}
                      onPress={() => handleSelectCategory(cat)}
                      activeOpacity={0.82}
                    >
                      <Text style={styles.categoryEmoji}>{cat.emoji}</Text>
                      <Text style={styles.categoryName}>{cat.name}</Text>
                      <Text style={styles.categoryCountries}>
                        {cat.countries.length} {cat.countries.length === 1 ? 'country' : 'countries'}
                      </Text>
                      <View style={styles.categoryRateRow}>
                        <Text style={styles.categoryRate}>
                          Up to ₦{Math.max(...cat.countries.map((c) => c.ratePerUnit)).toLocaleString()}/unit
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </ScrollView>
        ) : (
          /* ── STEP 2: Details form ────────────────────────────────────── */
          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

            {/* Country selector */}
            <Text style={styles.sectionLabel}>Country</Text>
            <TouchableOpacity
              style={styles.card}
              onPress={() => setCountryPickerOpen(true)}
              activeOpacity={0.85}
            >
              {selectedCountry ? (
                <View style={styles.selectedCountryRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.selectedCountryName}>{selectedCountry.name}</Text>
                    <Text style={styles.selectedCountryRate}>
                      Rate: ₦{selectedCountry.ratePerUnit.toLocaleString()} per {selectedCountry.currency}
                    </Text>
                  </View>
                  <Ionicons name="chevron-down" size={20} color={colors.secondaryText} />
                </View>
              ) : (
                <View style={styles.selectedCountryRow}>
                  <Text style={styles.placeholderText}>Select country</Text>
                  <Ionicons name="chevron-down" size={20} color={colors.secondaryText} />
                </View>
              )}
            </TouchableOpacity>

            {/* Denomination */}
            <Text style={styles.sectionLabel}>Card Value ({selectedCountry?.currency ?? 'USD'})</Text>
            <View style={styles.card}>
              <View style={styles.denomRow}>
                {DENOMINATIONS.map((d) => (
                  <TouchableOpacity
                    key={d}
                    style={[styles.denomChip, denomination === String(d) && styles.denomChipActive]}
                    onPress={() => setDenomination(String(d))}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.denomChipText, denomination === String(d) && styles.denomChipTextActive]}>
                      {d}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.denomInputWrap}>
                <TextInput
                  style={styles.denomInput}
                  value={denomination}
                  onChangeText={setDenomination}
                  placeholder="Or enter custom amount"
                  placeholderTextColor={colors.tertiaryText}
                  keyboardType="decimal-pad"
                />
                <Text style={styles.denomCurrency}>{selectedCountry?.currency ?? 'USD'}</Text>
              </View>
              {nairaAmount > 0 && (
                <View style={styles.nairaRow}>
                  <Text style={styles.nairaLabel}>You receive</Text>
                  <Text style={styles.nairaValue}>{formatCurrency(nairaAmount, 'NGN', true)}</Text>
                </View>
              )}
            </View>

            {/* Card code */}
            <Text style={styles.sectionLabel}>Card Code</Text>
            <View style={styles.card}>
              <TextInput
                style={styles.codeInput}
                value={cardCode}
                onChangeText={setCardCode}
                placeholder="Enter gift card code"
                placeholderTextColor={colors.tertiaryText}
                autoCapitalize="characters"
                autoCorrect={false}
              />
            </View>

            {/* PIN (optional) */}
            <Text style={styles.sectionLabel}>
              PIN <Text style={styles.optionalLabel}>(Optional)</Text>
            </Text>
            <View style={styles.card}>
              <TextInput
                style={styles.codeInput}
                value={cardPin}
                onChangeText={setCardPin}
                placeholder="Enter PIN if applicable"
                placeholderTextColor={colors.tertiaryText}
                keyboardType="number-pad"
              />
            </View>

            {/* Proof image */}
            <Text style={styles.sectionLabel}>Proof photo</Text>
            <View style={styles.card}>
              <Text style={styles.cardHint}>Upload a clear photo of the gift card or receipt</Text>
              <TouchableOpacity
                style={styles.uploadBox}
                onPress={proofImage ? undefined : pickImage}
                activeOpacity={0.85}
              >
                {proofImage ? (
                  <View style={styles.previewWrap}>
                    <Image source={{ uri: proofImage.uri }} style={styles.previewImage} resizeMode="cover" />
                    <TouchableOpacity style={styles.removeBtn} onPress={() => setProofImage(null)} hitSlop={12}>
                      <View style={styles.removeBtnInner}>
                        <Ionicons name="close" size={18} color={colors.primaryText} />
                      </View>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <Ionicons name="camera-outline" size={36} color={colors.secondaryText} />
                    <Text style={styles.uploadTitle}>Tap to upload photo</Text>
                    <Text style={styles.uploadHint}>PNG or JPG · max 5MB</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            {/* Notice */}
            <View style={styles.noticeCard}>
              <Ionicons name="shield-checkmark-outline" size={18} color={colors.primaryAccent} />
              <Text style={styles.noticeText}>
                Your card details are reviewed by our team within 30 minutes. Payout is sent directly to your saved bank account.
              </Text>
            </View>

            {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}

            {/* Submit */}
            <TouchableOpacity
              style={[styles.submitBtn, (!canSubmit || isSubmitting) && styles.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={!canSubmit || isSubmitting}
              activeOpacity={0.9}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <>
                  <Text style={styles.submitBtnText}>Submit Gift Card</Text>
                  <Ionicons name="arrow-forward" size={20} color="#000" />
                </>
              )}
            </TouchableOpacity>

            <View style={{ height: 32 }} />
          </ScrollView>
        )}

        {/* Country picker modal */}
        <Modal visible={countryPickerOpen} transparent animationType="slide">
          <Pressable style={styles.modalOverlay} onPress={() => setCountryPickerOpen(false)}>
            <View style={styles.pickerSheet}>
              <View style={styles.pickerHandle} />
              <Text style={styles.pickerTitle}>Select Country</Text>
              {selectedCategory?.countries.map((c) => (
                <TouchableOpacity
                  key={c.code}
                  style={[styles.pickerRow, selectedCountry?.code === c.code && styles.pickerRowActive]}
                  onPress={() => { setSelectedCountry(c); setCountryPickerOpen(false); }}
                  activeOpacity={0.8}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickerRowName}>{c.name}</Text>
                    <Text style={styles.pickerRowRate}>₦{c.ratePerUnit.toLocaleString()} per {c.currency}</Text>
                  </View>
                  {selectedCountry?.code === c.code && (
                    <Ionicons name="checkmark-circle" size={22} color={colors.primaryAccent} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Modal>

        {/* Success modal */}
        <Modal visible={showSuccess} transparent animationType="fade">
          <View style={styles.successOverlay}>
            <View style={styles.successCard}>
              <Ionicons name="checkmark-circle" size={64} color={colors.primaryAccent} />
              <Text style={styles.successTitle}>Gift Card Submitted!</Text>
              <Text style={styles.successMsg}>
                We'll review your card and send {nairaAmount > 0 ? formatCurrency(nairaAmount, 'NGN', true) : 'Naira'} to your bank within 30 minutes.
              </Text>
              <TouchableOpacity
                style={styles.successBtn}
                onPress={() => { setShowSuccess(false); router.replace('/(tabs)/(main)/history'); }}
                activeOpacity={0.9}
              >
                <Text style={styles.successBtnText}>View History</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.primaryBackground },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 12,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: colors.primaryText, letterSpacing: -0.5 },
  headerSub: { fontSize: 13, color: colors.secondaryText, marginTop: 2 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 24 },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  loadingText: { fontSize: 14, color: colors.secondaryText, marginTop: 12 },
  errorText: { fontSize: 14, color: colors.error, marginTop: 12 },
  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.secondaryText,
    textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 10, marginTop: 8,
  },
  // Category grid
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  categoryCard: {
    width: '47%',
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },
  categoryEmoji: { fontSize: 32, marginBottom: 10 },
  categoryName: { fontSize: 15, fontWeight: '700', color: colors.primaryText, marginBottom: 4 },
  categoryCountries: { fontSize: 12, color: colors.secondaryText, marginBottom: 8 },
  categoryRateRow: {},
  categoryRate: { fontSize: 12, fontWeight: '600', color: colors.primaryAccent },
  // Detail form
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 16,
  },
  selectedCountryRow: { flexDirection: 'row', alignItems: 'center' },
  selectedCountryName: { fontSize: 15, fontWeight: '700', color: colors.primaryText },
  selectedCountryRate: { fontSize: 12, color: colors.secondaryText, marginTop: 2 },
  placeholderText: { flex: 1, fontSize: 14, color: colors.tertiaryText },
  denomRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  denomChip: {
    paddingVertical: 8, paddingHorizontal: 14,
    borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceInput,
  },
  denomChipActive: { borderColor: colors.primaryAccent, backgroundColor: colors.accentDim },
  denomChipText: { fontSize: 14, fontWeight: '600', color: colors.secondaryText },
  denomChipTextActive: { color: colors.primaryAccent },
  denomInputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceInput,
    borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  denomInput: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.primaryText },
  denomCurrency: { fontSize: 13, fontWeight: '700', color: colors.secondaryText },
  nairaRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border,
  },
  nairaLabel: { fontSize: 14, color: colors.secondaryText, fontWeight: '500' },
  nairaValue: { fontSize: 20, fontWeight: '800', color: colors.primaryAccent },
  codeInput: {
    fontSize: 16, fontWeight: '600', color: colors.primaryText,
    backgroundColor: colors.surfaceInput, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border, padding: 14,
    letterSpacing: 1,
  },
  optionalLabel: { color: colors.tertiaryText, fontWeight: '400', textTransform: 'none', letterSpacing: 0 },
  cardHint: { fontSize: 13, color: colors.secondaryText, marginBottom: 12 },
  uploadBox: {
    height: 160, borderRadius: 14, borderWidth: 2, borderStyle: 'dashed',
    borderColor: colors.border, backgroundColor: colors.surfaceInput,
    alignItems: 'center', justifyContent: 'center',
  },
  uploadTitle: { fontSize: 14, fontWeight: '600', color: colors.secondaryText, marginTop: 10 },
  uploadHint: { fontSize: 12, color: colors.tertiaryText, marginTop: 4 },
  previewWrap: { width: '100%', height: '100%', borderRadius: 12, overflow: 'hidden', position: 'relative' },
  previewImage: { width: '100%', height: '100%' },
  removeBtn: { position: 'absolute', top: 10, right: 10 },
  removeBtnInner: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  noticeCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: colors.accentDim, borderRadius: 14,
    padding: 14, marginBottom: 20,
  },
  noticeText: { flex: 1, fontSize: 13, color: colors.primaryText, lineHeight: 19 },
  submitError: { fontSize: 13, color: colors.error, textAlign: 'center', marginBottom: 12 },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: colors.primaryAccent, borderRadius: 14, height: 56,
    ...Platform.select({
      ios: { shadowColor: colors.primaryAccent, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 },
      android: { elevation: 4 },
    }),
  },
  submitBtnDisabled: { backgroundColor: colors.secondaryText, opacity: 0.6 },
  submitBtnText: { fontSize: 16, fontWeight: '700', color: '#000' },
  // Country picker
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 40,
  },
  pickerHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 20 },
  pickerTitle: { fontSize: 18, fontWeight: '700', color: colors.primaryText, marginBottom: 16 },
  pickerRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: 12, marginBottom: 8,
    backgroundColor: colors.surfaceInput,
    borderWidth: 1, borderColor: colors.border,
  },
  pickerRowActive: { borderColor: colors.primaryAccent, backgroundColor: colors.accentDim },
  pickerRowName: { fontSize: 15, fontWeight: '700', color: colors.primaryText },
  pickerRowRate: { fontSize: 12, color: colors.secondaryText, marginTop: 2 },
  // Success modal
  successOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  successCard: {
    backgroundColor: colors.surface, borderRadius: 24, padding: 32,
    width: '100%', maxWidth: 340, alignItems: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  successTitle: { fontSize: 22, fontWeight: '800', color: colors.primaryText, marginTop: 16, marginBottom: 12, textAlign: 'center' },
  successMsg: { fontSize: 14, color: colors.secondaryText, textAlign: 'center', lineHeight: 21, marginBottom: 28 },
  successBtn: {
    backgroundColor: colors.primaryAccent, borderRadius: 14,
    paddingVertical: 16, width: '100%', alignItems: 'center',
  },
  successBtnText: { fontSize: 16, fontWeight: '700', color: '#000' },
});
