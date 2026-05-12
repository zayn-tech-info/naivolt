import { useState, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Image,
  useWindowDimensions,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useHasBankDetails } from '@/hooks/useHasBankDetails';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@/services/api';
import { type WalletCoinId } from '@/constants/config';
import { colors } from '@/constants/theme';
import { formatCurrency } from '@/utils/formatCurrency';

interface DepositAddressResponse {
  data?: {
    addressId: string;
    coin: string;
    network: string;
    address: string;
  };
}

const BRAND = {
  background: colors.primaryBackground,
  surface: colors.surface,
  surfaceElevated: colors.surfaceElevated,
  surfaceInput: colors.surfaceInput,
  accent: colors.primaryAccent,
  accentDim: colors.accentDim,
  primaryText: colors.primaryText,
  secondaryText: colors.secondaryText,
  tertiaryText: colors.tertiaryText,
  border: colors.border,
  borderLight: colors.borderLight,
  warning: colors.error,
  amber: colors.pending,
  successDim: colors.successDim,
};

const COINS: {
  id: WalletCoinId;
  symbol: string;
  name: string;
  network: string;
  color: string;
  warning: string;
}[] = [
  { id: 'usdt', symbol: 'USDT', name: 'Tether', network: 'TRC20', color: '#26A17B', warning: 'Only send on TRC20 network. Wrong network = permanent loss.' },
  { id: 'eth', symbol: 'ETH', name: 'Ethereum', network: 'ERC20', color: '#627EEA', warning: 'Only send on ERC20 (Ethereum) network.' },
  { id: 'btc', symbol: 'BTC', name: 'Bitcoin', network: 'Bitcoin', color: '#F7931A', warning: 'Only send on the Bitcoin network.' },
  { id: 'bnb', symbol: 'BNB', name: 'BNB', network: 'BEP20 (BSC)', color: '#F3BA2F', warning: 'Only send on BEP20 (BSC) network.' },
  { id: 'sol', symbol: 'SOL', name: 'Solana', network: 'Solana', color: '#9945FF', warning: 'Only send on the Solana network.' },
];

interface RateResponse {
  rate?: number;
  usdtToNgn?: number;
}

const DEFAULT_PLACEHOLDER_RATE = 0;

const COIN_GAP = 8;

const BANK_DETAILS_ALERT_TITLE = 'Bank details required';
const BANK_DETAILS_ALERT_MESSAGE =
  'You need to set your bank details first before you can convert. Add a bank account in Profile to receive Naira payments.';

export default function ConvertScreen() {
  const { width: screenWidth } = useWindowDimensions();
  const router = useRouter();
  const { hasBankDetails, isLoading: bankLoading } = useHasBankDetails();
  const [selectedCoinId, setSelectedCoinId] = useState<WalletCoinId>('usdt');
  const [cryptoInput, setCryptoInput] = useState('');
  const [copied, setCopied] = useState(false);
  const bankAlertShown = useRef(false);

  useEffect(() => {
    if (bankLoading) return;
    if (!hasBankDetails && !bankAlertShown.current) {
      bankAlertShown.current = true;
      Alert.alert(BANK_DETAILS_ALERT_TITLE, BANK_DETAILS_ALERT_MESSAGE, [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Add Bank Account',
          onPress: () => router.replace('/(tabs)/(main)/profile'),
        },
      ]);
    }
  }, [hasBankDetails, bankLoading, router]);

  const selectedCoin = COINS.find((c) => c.id === selectedCoinId) ?? COINS[0];
  const coinButtonWidth = (screenWidth - 40 - (COINS.length - 1) * COIN_GAP) / COINS.length;

  const {
    data: depositData,
    isLoading: depositLoading,
    isError: depositError,
    refetch: refetchDeposit,
  } = useQuery({
    queryKey: ['depositAddress', selectedCoinId],
    queryFn: async () => {
      const res = await api.get<DepositAddressResponse>(`/deposit-address?coin=${selectedCoin.symbol}`);
      return res.data?.data ?? null;
    },
    staleTime: 10 * 60 * 1000, // keep the same address for 10 min
    retry: 2,
  });

  const { data: rateData, isLoading: rateLoading, isError: rateError } = useQuery({
    queryKey: ['rate', selectedCoinId],
    queryFn: async () => {
      try {
        const res = await api.get<RateResponse>(`/rate?coin=${selectedCoinId}`);
        const rate = res.data?.rate ?? res.data?.usdtToNgn ?? DEFAULT_PLACEHOLDER_RATE;
        return { rate: Number(rate) || DEFAULT_PLACEHOLDER_RATE };
      } catch {
        return { rate: DEFAULT_PLACEHOLDER_RATE };
      }
    },
    refetchInterval: 60 * 1000,
  });

  const rate = rateData?.rate ?? DEFAULT_PLACEHOLDER_RATE;
  const rateFormatted = rate > 0 ? formatCurrency(rate, 'NGN', true) : '—';

  const cryptoAmount = useMemo(() => {
    const n = parseFloat(cryptoInput.replace(/,/g, '')) || 0;
    return Number.isFinite(n) ? n : 0;
  }, [cryptoInput]);

  const nairaAmount = useMemo(() => {
    if (!rate || cryptoAmount <= 0) return 0;
    return cryptoAmount * rate;
  }, [rate, cryptoAmount]);

  const nairaDisplay = nairaAmount > 0
    ? formatCurrency(nairaAmount, 'NGN', true)
    : '0';

  const walletAddress = depositData?.address ?? '';
  const walletAddressId = depositData?.addressId ?? '';

  const handleCopy = async () => {
    if (!walletAddress) return;
    await Clipboard.setStringAsync(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmitProof = () => {
    if (cryptoAmount <= 0) {
      Alert.alert('Enter amount', `Please enter the amount of ${selectedCoin.symbol} you sent before continuing.`);
      return;
    }
    if (!walletAddress || !walletAddressId) {
      Alert.alert('No deposit address', 'Could not assign a deposit address. Please try again.');
      return;
    }
    router.push({
      pathname: '/submit-transaction',
      params: {
        amount: String(cryptoAmount),
        coin: selectedCoin.symbol,
        network: selectedCoin.network,
        rate: String(rate),
        depositAddressId: walletAddressId,
      },
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* 1. Header */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Convert</Text>
            <Text style={styles.titleAccent}>{selectedCoin.symbol} → NGN</Text>
          </View>
          <View style={styles.headerBadge}>
            <View style={styles.headerBadgeDot} />
            <Text style={styles.headerBadgeText}>Instant</Text>
          </View>
        </View>
        <Text style={styles.subtitle}>Send crypto and receive Naira at live rates</Text>

        {/* Coin Selector — equal width per coin */}
        <View style={styles.coinSelector}>
          <View style={[styles.coinSelectorRow, { gap: COIN_GAP }]}>
            {COINS.map((coin) => {
              const isSelected = coin.id === selectedCoinId;
              return (
                <TouchableOpacity
                  key={coin.id}
                  style={[
                    styles.coinButton,
                    { width: coinButtonWidth },
                    isSelected && styles.coinButtonSelected,
                  ]}
                  onPress={() => setSelectedCoinId(coin.id)}
                  activeOpacity={0.8}
                >
                  <View style={[styles.coinLogo, { backgroundColor: coin.color }]}>
                    <Text style={styles.coinSymbol}>{coin.symbol}</Text>
                  </View>
                  <Text style={styles.coinName} numberOfLines={1}>{coin.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* 2. Rate Display Card */}
        <View style={styles.rateCard}>
          <View style={styles.rateCardTop}>
            <Text style={styles.rateCardLabel}>Live rate</Text>
            {!rateError && (
              <View style={styles.livePill}>
                <View style={styles.livePillDot} />
                <Text style={styles.livePillText}>LIVE</Text>
              </View>
            )}
          </View>
          {rateLoading ? (
            <ActivityIndicator size="small" color={BRAND.accent} style={styles.rateLoader} />
          ) : rateError ? (
            <Text style={styles.rateError}>Unable to load rate</Text>
          ) : (
            <View style={styles.rateRow}>
              <Text style={styles.rateFrom}>1 {selectedCoin.symbol}</Text>
              <Ionicons name="arrow-forward" size={18} color={BRAND.tertiaryText} style={styles.rateArrow} />
              <Text style={styles.rateTo}>{rateFormatted}</Text>
            </View>
          )}
        </View>

        {/* 3. Calculator */}
        <View style={styles.calcCard}>
          <Text style={styles.calcCardTitle}>Quick convert</Text>
          <View style={styles.calcPanel}>
            <Text style={styles.calcPanelLabel}>You send</Text>
            <View style={styles.calcInputWrap}>
              <TextInput
                style={styles.calcInput}
                value={cryptoInput}
                onChangeText={setCryptoInput}
                placeholder="0.00"
                placeholderTextColor={BRAND.tertiaryText}
                keyboardType="decimal-pad"
                editable={!rateLoading}
              />
              <View style={[styles.calcAssetBadge, { backgroundColor: selectedCoin.color }]}>
                <Text style={styles.calcAssetText}>{selectedCoin.symbol}</Text>
              </View>
            </View>
          </View>
          <View style={styles.calcArrowWrap}>
            <View style={styles.calcArrowLine} />
            <View style={styles.calcArrowCircle}>
              <Ionicons name="arrow-down" size={20} color={BRAND.background} />
            </View>
            <View style={styles.calcArrowLine} />
          </View>
          <View style={[styles.calcPanel, styles.calcPanelReceive]}>
            <Text style={styles.calcPanelLabel}>You receive</Text>
            <View style={styles.calcOutputWrap}>
              <Text style={[styles.calcOutput, nairaAmount <= 0 && styles.calcOutputMuted]}>
                {nairaDisplay}
              </Text>
              <View style={[styles.calcAssetBadge, styles.calcAssetBadgeNgn]}>
                <Text style={styles.calcAssetText}>NGN</Text>
              </View>
            </View>
          </View>
        </View>

        {/* 4. Wallet Address Card */}
        <View style={styles.walletCard}>
          <View style={styles.walletCardHeader}>
            <View style={styles.walletTitleRow}>
              <View style={[styles.walletIconWrap, { backgroundColor: `${selectedCoin.color}20` }]}>
                <Ionicons name="wallet-outline" size={20} color={selectedCoin.color} />
              </View>
              <Text style={styles.walletTitle}>Deposit address</Text>
            </View>
            <View style={[styles.networkBadge, { backgroundColor: `${selectedCoin.color}20` }]}>
              <Text style={[styles.networkBadgeText, { color: selectedCoin.color }]}>{selectedCoin.network}</Text>
            </View>
          </View>
          <Text style={styles.walletSubtitle}>Send {selectedCoin.symbol} to this address only</Text>

          {depositLoading ? (
            <View style={styles.addressPlaceholder}>
              <ActivityIndicator size="small" color={BRAND.accent} />
              <Text style={[styles.addressPlaceholderText, { marginTop: 10 }]}>
                Generating your deposit address…
              </Text>
            </View>
          ) : depositError || !walletAddress ? (
            <View style={styles.addressPlaceholder}>
              <Ionicons name="alert-circle-outline" size={28} color={BRAND.warning} />
              <Text style={[styles.addressPlaceholderText, { marginTop: 8 }]}>
                No address available for {selectedCoin.symbol} right now.
              </Text>
              <TouchableOpacity onPress={() => refetchDeposit()} style={{ marginTop: 10 }}>
                <Text style={{ color: BRAND.accent, fontWeight: '700', fontSize: 14 }}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.qrSection}>
                <Text style={styles.qrLabel}>Scan to pay</Text>
                <View style={styles.qrContainer}>
                  <Image
                    source={{
                      uri: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(walletAddress)}`,
                    }}
                    style={styles.qrImage}
                    resizeMode="contain"
                  />
                </View>
              </View>

              <View style={styles.addressSection}>
                <View style={styles.addressLabelRow}>
                  <Text style={styles.addressLabel}>Your unique deposit address</Text>
                  <View style={styles.uniqueBadge}>
                    <Text style={styles.uniqueBadgeText}>UNIQUE</Text>
                  </View>
                </View>
                <View style={styles.addressBox}>
                  <Text style={styles.walletAddress} selectable numberOfLines={2}>
                    {walletAddress}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.copyBtn, copied && styles.copyBtnSuccess]}
                  onPress={handleCopy}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name={copied ? 'checkmark-circle' : 'copy-outline'}
                    size={20}
                    color="#000000"
                  />
                  <Text style={styles.copyBtnText}>
                    {copied ? 'Copied!' : 'Copy address'}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>

        {/* 5. Important Notice */}
        <View style={styles.noticeCard}>
          <View style={styles.noticeTitleRow}>
            <Ionicons name="information-circle" size={22} color={BRAND.amber} />
            <Text style={styles.noticeTitle}>Important</Text>
          </View>
          <Text style={styles.noticeText}>• {selectedCoin.warning}</Text>
          <Text style={styles.noticeText}>• Minimum amount may apply</Text>
          <Text style={styles.noticeText}>• After sending, submit your proof below</Text>
        </View>

        {/* 6. Bottom Button */}
        <TouchableOpacity
          style={styles.submitBtn}
          onPress={handleSubmitProof}
          activeOpacity={0.9}
        >
          <Text style={styles.submitBtnText}>{"I've sent"} {selectedCoin.symbol} — Submit proof</Text>
          <Ionicons name="arrow-forward" size={20} color="#000000" style={styles.submitBtnIcon} />
        </TouchableOpacity>

        <View style={styles.bottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: BRAND.background,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: BRAND.primaryText,
    letterSpacing: -0.5,
  },
  titleAccent: {
    fontSize: 18,
    fontWeight: '600',
    color: BRAND.accent,
    marginTop: 2,
    letterSpacing: 0.3,
  },
  headerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: BRAND.accentDim,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },
  headerBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: BRAND.accent,
  },
  headerBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: BRAND.accent,
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 14,
    color: BRAND.secondaryText,
    marginBottom: 16,
    lineHeight: 20,
  },
  coinSelector: {
    marginBottom: 20,
    marginHorizontal: -20,
  },
  coinSelectorRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
  },
  coinButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: BRAND.surface,
  },
  coinButtonSelected: {
    borderColor: BRAND.accent,
    backgroundColor: BRAND.surface,
  },
  coinLogo: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  coinSymbol: {
    fontSize: 12,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  coinName: {
    fontSize: 11,
    fontWeight: '600',
    color: BRAND.secondaryText,
    textAlign: 'center',
  },
  rateCard: {
    backgroundColor: BRAND.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BRAND.border,
    padding: 20,
    marginBottom: 20,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
      },
      android: { elevation: 6 },
    }),
  },
  rateCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  rateCardLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: BRAND.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: BRAND.accentDim,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  livePillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: BRAND.accent,
  },
  livePillText: {
    fontSize: 10,
    fontWeight: '800',
    color: BRAND.accent,
    letterSpacing: 0.8,
  },
  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  rateFrom: {
    fontSize: 18,
    fontWeight: '600',
    color: BRAND.primaryText,
  },
  rateArrow: {
    marginHorizontal: 10,
  },
  rateTo: {
    fontSize: 22,
    fontWeight: '800',
    color: BRAND.accent,
    letterSpacing: -0.3,
  },
  rateLoader: {
    marginVertical: 8,
  },
  rateError: {
    fontSize: 14,
    color: BRAND.warning,
    marginTop: 4,
  },
  calcCard: {
    backgroundColor: BRAND.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BRAND.border,
    padding: 20,
    marginBottom: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  },
  calcCardTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: BRAND.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 16,
  },
  calcPanel: {
    marginBottom: 0,
  },
  calcPanelReceive: {
    marginBottom: 0,
    marginTop: 0,
  },
  calcPanelLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: BRAND.secondaryText,
    marginBottom: 10,
  },
  calcInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BRAND.surfaceInput,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BRAND.border,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 14 : 10,
  },
  calcInput: {
    flex: 1,
    fontSize: 24,
    fontWeight: '700',
    color: BRAND.primaryText,
    paddingVertical: 0,
    paddingHorizontal: 0,
    textAlign: 'left',
  },
  calcAssetBadge: {
    backgroundColor: BRAND.borderLight,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginLeft: 12,
  },
  calcAssetBadgeNgn: {
    backgroundColor: BRAND.successDim,
  },
  calcAssetText: {
    fontSize: 13,
    fontWeight: '700',
    color: BRAND.primaryText,
  },
  calcArrowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
  },
  calcArrowLine: {
    flex: 1,
    height: 1,
    backgroundColor: BRAND.border,
  },
  calcArrowCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: BRAND.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 12,
  },
  calcOutputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BRAND.surfaceInput,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BRAND.border,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 14 : 10,
  },
  calcOutput: {
    flex: 1,
    fontSize: 24,
    fontWeight: '700',
    color: BRAND.accent,
  },
  calcOutputMuted: {
    color: BRAND.tertiaryText,
  },
  walletCard: {
    backgroundColor: BRAND.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BRAND.border,
    padding: 20,
    marginBottom: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 8,
      },
      android: { elevation: 3 },
    }),
  },
  walletCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  walletTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  walletIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: BRAND.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  walletTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: BRAND.primaryText,
  },
  networkBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  networkBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  walletSubtitle: {
    fontSize: 13,
    color: BRAND.secondaryText,
    marginBottom: 20,
  },
  qrSection: {
    alignItems: 'center',
    marginBottom: 24,
  },
  qrLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: BRAND.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 12,
  },
  qrContainer: {
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrImage: {
    width: 200,
    height: 200,
  },
  addressSection: {
    borderTopWidth: 1,
    borderTopColor: BRAND.border,
    paddingTop: 20,
  },
  addressLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  addressLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: BRAND.secondaryText,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  uniqueBadge: {
    backgroundColor: BRAND.accentDim,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  uniqueBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: BRAND.accent,
    letterSpacing: 0.8,
  },
  addressBox: {
    backgroundColor: BRAND.surfaceInput,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: BRAND.border,
  },
  walletAddress: {
    fontSize: 13,
    color: BRAND.primaryText,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: BRAND.accent,
    borderRadius: 14,
    paddingVertical: 14,
  },
  copyBtnSuccess: {
    backgroundColor: 'rgba(170, 255, 0, 0.9)',
  },
  copyBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000000',
  },
  addressPlaceholder: {
    padding: 20,
    backgroundColor: BRAND.surfaceInput,
    borderRadius: 14,
    alignItems: 'center',
  },
  addressPlaceholderText: {
    fontSize: 13,
    color: BRAND.secondaryText,
  },
  noticeCard: {
    backgroundColor: BRAND.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BRAND.border,
    borderLeftWidth: 4,
    borderLeftColor: BRAND.amber,
    padding: 20,
    marginBottom: 24,
  },
  noticeTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  noticeTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: BRAND.amber,
  },
  noticeText: {
    fontSize: 13,
    color: BRAND.secondaryText,
    marginBottom: 6,
    lineHeight: 20,
  },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: BRAND.accent,
    borderRadius: 14,
    height: 56,
    ...Platform.select({
      ios: {
        shadowColor: BRAND.accent,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 8,
      },
      android: { elevation: 4 },
    }),
  },
  submitBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000000',
  },
  submitBtnIcon: {
    marginLeft: 0,
  },
  bottomSpacer: {
    height: 32,
  },
});
