/**
 * ConvertCalculator — stacked send / receive cards with a seam swap control.
 *
 * Coin is a tappable pill. Rate lives as a caption under the receive side.
 * Either amount field stays editable; swap flips which card sits on top.
 */

import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, elevation } from '@/design';
import { AssetGlyph, Input, Text } from '@/components/ui';
import type { Asset, ChainMeta } from '@/services/v2/types';

export type CalcSource = 'crypto' | 'ngn';

export interface ConvertCalculatorProps {
  asset: Asset;
  network: ChainMeta | null;
  rate: number | null;
  cryptoAmount: string;
  ngnAmount: string;
  /** When true, crypto card is on top (default). */
  cryptoFirst: boolean;
  onCryptoChange: (value: string) => void;
  onNgnChange: (value: string) => void;
  onPressAsset: () => void;
  onPressNetwork?: () => void;
  onSwap: () => void;
}

function sanitizeDecimal(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const parts = cleaned.split('.');
  if (parts.length <= 1) return cleaned;
  return `${parts[0]}.${parts.slice(1).join('')}`;
}

export function ConvertCalculator({
  asset,
  network,
  rate,
  cryptoAmount,
  ngnAmount,
  cryptoFirst,
  onCryptoChange,
  onNgnChange,
  onPressAsset,
  onPressNetwork,
  onSwap,
}: ConvertCalculatorProps) {
  const { c, space, radius, minTouch } = useTheme();

  const rateCaption =
    rate != null && rate > 0 ? (
      <Text variant="caption" color="tertiaryText">
        1 {asset} ≈ ₦{formatNgn(rate)}
      </Text>
    ) : (
      <Text variant="caption" color="tertiaryText">
        Rate unavailable for this coin right now
      </Text>
    );

  const cryptoCard = (
    <View
      style={{
        padding: space.roomy,
        borderRadius: radius.card,
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.hairline,
        gap: space.comfy,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Text variant="eyebrow" color="tertiaryText" style={{ marginTop: space.base }}>
          You send
        </Text>
        <View style={{ alignItems: 'flex-end', gap: space.tight, maxWidth: '72%' }}>
          <Pressable
            onPress={onPressAsset}
            accessibilityRole="button"
            accessibilityLabel={`Selected coin ${asset}. Change coin`}
            hitSlop={8}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.snug,
              minHeight: minTouch,
              paddingHorizontal: space.base,
              paddingVertical: space.snug,
              borderRadius: radius.chip,
              backgroundColor: pressed ? c.surfaceElevated : c.surfaceSunken,
              borderWidth: 1,
              borderColor: c.hairline,
            })}
          >
            <AssetGlyph asset={asset} size={28} />
            <Text variant="subheading">{asset}</Text>
            <Ionicons name="chevron-down" size={14} color={c.tertiaryText} />
          </Pressable>
          {network ? (
            <Pressable
              onPress={onPressNetwork}
              disabled={!onPressNetwork}
              accessibilityRole={onPressNetwork ? 'button' : undefined}
              accessibilityLabel={
                onPressNetwork ? `Network ${network.network}. Change network` : `Network ${network.network}`
              }
              style={({ pressed }) => ({
                paddingHorizontal: space.base,
                paddingVertical: space.tight,
                borderRadius: radius.chip,
                backgroundColor: c.accentDim,
                opacity: pressed && onPressNetwork ? 0.85 : 1,
              })}
            >
              <Text variant="caption" color="primaryAccent">
                {network.network}
              </Text>
            </Pressable>
          ) : onPressNetwork ? (
            <Pressable
              onPress={onPressNetwork}
              accessibilityRole="button"
              accessibilityLabel="Choose network"
              style={({ pressed }) => ({
                paddingHorizontal: space.base,
                paddingVertical: space.tight,
                borderRadius: radius.chip,
                backgroundColor: pressed ? c.surfaceElevated : c.surfaceSunken,
                borderWidth: 1,
                borderColor: c.hairline,
              })}
            >
              <Text variant="caption" color="tertiaryText">
                Choose network
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <Input
        label={`${asset} amount`}
        value={cryptoAmount}
        onChangeText={(t) => onCryptoChange(sanitizeDecimal(t))}
        keyboardType="decimal-pad"
        placeholder="0"
        mono
        prefix={asset}
      />
    </View>
  );

  const ngnCard = (
    <View
      style={{
        padding: space.roomy,
        borderRadius: radius.card,
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.hairline,
        gap: space.comfy,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="eyebrow" color="tertiaryText">
          You receive
        </Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.snug,
            paddingHorizontal: space.base,
            paddingVertical: space.snug,
            borderRadius: radius.chip,
            backgroundColor: c.surfaceSunken,
            borderWidth: 1,
            borderColor: c.hairline,
            minHeight: minTouch,
          }}
        >
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: radius.chip,
              backgroundColor: c.positiveDim,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text variant="caption" color="positive">
              ₦
            </Text>
          </View>
          <Text variant="subheading">NGN</Text>
        </View>
      </View>

      <Input
        label="Amount (approx.)"
        value={ngnAmount}
        onChangeText={(t) => onNgnChange(sanitizeDecimal(t))}
        keyboardType="decimal-pad"
        placeholder="0"
        mono
        prefix="₦"
      />

      {rateCaption}
    </View>
  );

  return (
    <View>
      {cryptoFirst ? cryptoCard : ngnCard}

      <View
        style={{
          zIndex: 2,
          alignItems: 'center',
          marginTop: -22,
          marginBottom: -22,
        }}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={onSwap}
          accessibilityRole="button"
          accessibilityLabel="Swap send and receive"
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: radius.chip,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? c.surfaceElevated : c.surface,
            borderWidth: 1,
            borderColor: c.borderLight,
            ...elevation(1),
          })}
        >
          <Ionicons name="arrow-down" size={20} color={c.primaryText} />
        </Pressable>
      </View>

      {cryptoFirst ? ngnCard : cryptoCard}
    </View>
  );
}

export function formatNgn(value: number): string {
  return value.toLocaleString('en-NG', {
    maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}

export function formatCrypto(value: number, asset: Asset): string {
  const digits = asset === 'BTC' ? 8 : asset === 'ETH' || asset === 'BNB' || asset === 'SOL' ? 6 : 2;
  const fixed = value.toFixed(digits).replace(/\.?0+$/, '');
  return fixed === '' ? '0' : fixed;
}

export function deriveNgn(crypto: string, rate: number | null): string {
  if (rate == null || rate <= 0) return '';
  const n = Number(crypto);
  if (!Number.isFinite(n) || crypto === '') return '';
  return formatNgn(n * rate);
}

export function deriveCrypto(ngn: string, rate: number | null, asset: Asset): string {
  if (rate == null || rate <= 0) return '';
  const n = Number(ngn);
  if (!Number.isFinite(n) || ngn === '') return '';
  return formatCrypto(n / rate, asset);
}

export default ConvertCalculator;
