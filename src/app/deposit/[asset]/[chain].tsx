/**
 * Deposit — step 3: the address.
 *
 * High stakes: wrong network loses funds permanently. The screen leads with a
 * danger warning, then QR + address, then facts and rules. Colour is reserved
 * for the irreversible risk; everything else stays neutral.
 */

import { ScrollView, View, type ImageSourcePropType } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/design';
import {
  Button,
  COIN_IMAGE,
  CopyField,
  Screen,
  Skeleton,
  Text,
} from '@/components/ui';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { useDepositAddress } from '@/hooks/useExchange';
import { CHAINS_FOR_ASSET, parseAsset, parseChainFor } from '@/constants/assets';

const QR_SIZE = 196;
const CORNER = 18;
const CORNER_STROKE = 2;

export default function DepositAddressScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { c, radius, space } = useTheme();
  const params = useLocalSearchParams<{ asset: string; chain: string; amount?: string }>();

  const asset = parseAsset(params.asset);
  const chain = asset ? parseChainFor(asset, params.chain) : null;
  const amountParam = Array.isArray(params.amount) ? params.amount[0] : params.amount;
  const sendAmount =
    typeof amountParam === 'string' && amountParam.trim() !== '' && Number(amountParam) > 0
      ? amountParam.trim()
      : null;

  const ready = !!asset && !!chain;
  const { data: deposit, isLoading } = useDepositAddress(asset!, chain!, ready);

  if (!asset) return <Redirect href="/deposit" />;
  if (!chain) return <Redirect href={{ pathname: '/deposit/[asset]', params: { asset } }} />;

  const meta = (CHAINS_FOR_ASSET[asset] ?? []).find((x) => x.chain === chain);
  const networkLabel = deposit?.network ?? meta?.network ?? chain;
  const coinLogo = COIN_IMAGE[asset] as ImageSourcePropType | undefined;

  return (
    <Screen scroll={false} edges={['top']} contentStyle={{ paddingHorizontal: 0 }}>
      <View style={{ paddingHorizontal: space.roomy }}>
        <ScreenHeader title={`${asset} · ${networkLabel}`} onBack={() => router.back()} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: space.roomy,
          paddingTop: space.base,
          paddingBottom: space.section,
          gap: space.roomy,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Danger network warning */}
        <View
          style={{
            flexDirection: 'row',
            gap: space.base,
            padding: space.comfy,
            borderRadius: radius.card,
            backgroundColor: c.dangerDim,
            borderWidth: 1,
            borderColor: c.danger,
          }}
        >
          <Ionicons name="alert-circle" size={22} color={c.danger} style={{ marginTop: 1 }} />
          <View style={{ flex: 1, gap: space.tight }}>
            <Text variant="subheading" color="danger">
              {networkLabel} only — irreversible
            </Text>
            <Text variant="bodySmall" color="secondaryText">
              Send {asset} on {networkLabel} only. Any other network permanently destroys the funds.
            </Text>
          </View>
        </View>

        {sendAmount ? (
          <View style={{ gap: space.tight }}>
            <Text variant="eyebrow" color="tertiaryText">
              From calculator
            </Text>
            <Text variant="subheading">
              Send about {sendAmount} {asset}
            </Text>
            <Text variant="caption" color="tertiaryText">
              Exact amount is yours to choose. This is the figure you entered on Rate.
            </Text>
          </View>
        ) : null}

        {isLoading || !deposit ? (
          <View style={{ alignItems: 'center', gap: space.comfy }}>
            <Skeleton width={QR_SIZE + 40} height={QR_SIZE + 40} radius={radius.card} />
            <Skeleton width="100%" height={56} radius={radius.card} />
          </View>
        ) : (
          <>
            {/* QR with scan-target corners + coin watermark */}
            <View style={{ alignItems: 'center', gap: space.comfy }}>
              <View
                style={{
                  backgroundColor: c.surface,
                  padding: space.roomy,
                  borderRadius: radius.card,
                }}
              >
                <View style={{ width: QR_SIZE + 28, height: QR_SIZE + 28, alignItems: 'center', justifyContent: 'center' }}>
                  <ScanCorners color={c.primaryText} size={QR_SIZE + 28} />
                  <View
                    style={{
                      width: QR_SIZE,
                      height: QR_SIZE,
                      backgroundColor: '#FFFFFF',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <QRCode
                      value={deposit.address}
                      size={QR_SIZE}
                      backgroundColor="#FFFFFF"
                      color="#000000"
                      logo={coinLogo}
                      logoSize={36}
                      logoBackgroundColor="#FFFFFF"
                      logoMargin={4}
                      logoBorderRadius={18}
                      quietZone={0}
                    />
                  </View>
                </View>
              </View>

              <View style={{ width: '100%' }}>
                <CopyField
                  value={deposit.address}
                  label={`${asset} · ${networkLabel} address`}
                  groupSize={4}
                  tone="neutral"
                />
              </View>
            </View>

            {/* Facts — two-column rows, light dividers */}
            <View style={{ gap: 0 }}>
              <Fact
                label="Minimum deposit"
                value={`${deposit.minimumDeposit} ${asset}`}
              />
              <Fact
                label="Credited after"
                value={`${deposit.minConfirmations} confirmation${
                  deposit.minConfirmations === 1 ? '' : 's'
                }`}
              />
              <Fact label="Deposit fee" value="Free" last />
            </View>

            {/* Before you send */}
            <View style={{ gap: space.comfy }}>
              <Text variant="subheading">Before you send</Text>
              <View style={{ gap: space.base }}>
                <Rule>
                  Send only <Text variant="amountSmall">{asset}</Text> on{' '}
                  <Text variant="amountSmall">{networkLabel}</Text>. Any other coin or network is
                  lost permanently and cannot be recovered.
                </Rule>
                <Rule>
                  Send at least{' '}
                  <Text variant="amountSmall">
                    {deposit.minimumDeposit} {asset}
                  </Text>
                  . Anything below the minimum will not be credited.
                </Rule>
                <Rule>
                  Copy the address exactly, or scan the QR. Never type it by hand — a single wrong
                  character sends the funds to a stranger.
                </Rule>
                <Rule>
                  Your naira is credited after {deposit.minConfirmations} confirmation
                  {deposit.minConfirmations === 1 ? '' : 's'} at the rate current when the coin
                  arrives.
                </Rule>
              </View>
            </View>

            <Text variant="caption" color="tertiaryText" align="center">
              This address is permanently yours. You can reuse it for every {asset} deposit on{' '}
              {networkLabel}.
            </Text>
          </>
        )}
      </ScrollView>

      <View
        style={{
          paddingHorizontal: space.roomy,
          paddingTop: space.comfy,
          paddingBottom: Math.max(insets.bottom, space.comfy),
          borderTopWidth: 1,
          borderTopColor: c.hairline,
          backgroundColor: c.primaryBackground,
        }}
      >
        <Button
          title="Done"
          onPress={() => router.dismissTo('/(tabs)/(main)')}
          fullWidth
          haptic="medium"
        />
      </View>
    </Screen>
  );
}

/** L-shaped scan-target marks at the four corners of the QR frame. */
function ScanCorners({ color, size }: { color: string; size: number }) {
  const arm = CORNER;
  const stroke = CORNER_STROKE;
  const common = { position: 'absolute' as const, width: arm, height: arm };

  return (
    <View style={{ position: 'absolute', width: size, height: size }} pointerEvents="none">
      {/* Top left */}
      <View style={[common, { top: 0, left: 0 }]}>
        <View style={{ position: 'absolute', top: 0, left: 0, width: arm, height: stroke, backgroundColor: color }} />
        <View style={{ position: 'absolute', top: 0, left: 0, width: stroke, height: arm, backgroundColor: color }} />
      </View>
      {/* Top right */}
      <View style={[common, { top: 0, right: 0 }]}>
        <View style={{ position: 'absolute', top: 0, right: 0, width: arm, height: stroke, backgroundColor: color }} />
        <View style={{ position: 'absolute', top: 0, right: 0, width: stroke, height: arm, backgroundColor: color }} />
      </View>
      {/* Bottom left */}
      <View style={[common, { bottom: 0, left: 0 }]}>
        <View style={{ position: 'absolute', bottom: 0, left: 0, width: arm, height: stroke, backgroundColor: color }} />
        <View style={{ position: 'absolute', bottom: 0, left: 0, width: stroke, height: arm, backgroundColor: color }} />
      </View>
      {/* Bottom right */}
      <View style={[common, { bottom: 0, right: 0 }]}>
        <View style={{ position: 'absolute', bottom: 0, right: 0, width: arm, height: stroke, backgroundColor: color }} />
        <View style={{ position: 'absolute', bottom: 0, right: 0, width: stroke, height: arm, backgroundColor: color }} />
      </View>
    </View>
  );
}

function Rule({ children }: { children: React.ReactNode }) {
  const { c, space } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: space.base }}>
      <View
        style={{
          width: 4,
          height: 4,
          borderRadius: 1,
          backgroundColor: c.primaryText,
          marginTop: 8,
        }}
      />
      <Text variant="body" color="secondaryText" style={{ flex: 1, lineHeight: 22 }}>
        {children}
      </Text>
    </View>
  );
}

function Fact({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  const { c, space } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        paddingVertical: space.comfy,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <Text variant="body" color="tertiaryText">
        {label}
      </Text>
      <Text variant="amountSmall" style={{ textAlign: 'right', flexShrink: 1, marginLeft: space.base }}>
        {value}
      </Text>
    </View>
  );
}
