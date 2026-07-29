/**
 * AssetGlyph — the coin mark.
 *
 * Real coin artwork, vendored into `assets/images/coins/` from the
 * `cryptocurrency-icons` set (CC0-1.0, so no attribution obligation). Bundled
 * rather than fetched: an icon that arrives over the network shows an empty hole
 * on a cold start, and on a screen where the user is identifying which asset
 * they're about to send, a missing mark is worse than no mark.
 *
 * Only the assets the app actually supports are vendored — 16 files, ~100KB
 * total — instead of the full 483-icon package. Adding an asset means dropping
 * a PNG in and adding a line to COIN_IMAGE.
 *
 * `require` calls must be static and enumerated: Metro resolves them at build
 * time, so a computed `require(\`...${asset}.png\`)` silently fails to bundle.
 *
 * Anything without artwork falls back to a lettermark on a deterministic hue —
 * which is what NGN uses, since naira is not a coin and would look wrong with
 * a token logo.
 */

import { View } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '@/design';
import Text from './Text';

/** Static require map. See the note above about why this can't be computed. */
const COIN_IMAGE: Record<string, ReturnType<typeof require>> = {
  USDT: require('../../../assets/images/coins/usdt.png'),
  USDC: require('../../../assets/images/coins/usdc.png'),
  BTC: require('../../../assets/images/coins/btc.png'),
  ETH: require('../../../assets/images/coins/eth.png'),
  BNB: require('../../../assets/images/coins/bnb.png'),
  SOL: require('../../../assets/images/coins/sol.png'),
  TRX: require('../../../assets/images/coins/trx.png'),
  MATIC: require('../../../assets/images/coins/matic.png'),
  LTC: require('../../../assets/images/coins/ltc.png'),
  DOGE: require('../../../assets/images/coins/doge.png'),
  ADA: require('../../../assets/images/coins/ada.png'),
  XRP: require('../../../assets/images/coins/xrp.png'),
  DAI: require('../../../assets/images/coins/dai.png'),
  AVAX: require('../../../assets/images/coins/avax.png'),
  DOT: require('../../../assets/images/coins/dot.png'),
  LINK: require('../../../assets/images/coins/link.png'),
};

/**
 * Brand colour and display name per asset. The colour is still needed even with
 * artwork present — pickers tint their selected border with it, and the fallback
 * lettermark uses it.
 */
export const ASSET_META: Record<string, { color: string; mark: string; name: string }> = {
  USDT: { color: '#26A17B', mark: '₮', name: 'Tether' },
  USDC: { color: '#2775CA', mark: '$', name: 'USD Coin' },
  BTC: { color: '#F7931A', mark: '₿', name: 'Bitcoin' },
  ETH: { color: '#627EEA', mark: 'Ξ', name: 'Ethereum' },
  BNB: { color: '#F0B90B', mark: 'B', name: 'BNB' },
  SOL: { color: '#9945FF', mark: 'S', name: 'Solana' },
  TRX: { color: '#EF0027', mark: 'T', name: 'TRON' },
  MATIC: { color: '#8247E5', mark: 'M', name: 'Polygon' },
  LTC: { color: '#345D9D', mark: 'Ł', name: 'Litecoin' },
  DOGE: { color: '#C2A633', mark: 'D', name: 'Dogecoin' },
  ADA: { color: '#0033AD', mark: 'A', name: 'Cardano' },
  XRP: { color: '#23292F', mark: 'X', name: 'XRP' },
  DAI: { color: '#F5AC37', mark: 'D', name: 'Dai' },
  AVAX: { color: '#E84142', mark: 'A', name: 'Avalanche' },
  DOT: { color: '#E6007A', mark: 'P', name: 'Polkadot' },
  LINK: { color: '#2A5ADA', mark: 'L', name: 'Chainlink' },
  NGN: { color: '#00875A', mark: '₦', name: 'Naira' },
};

export interface AssetGlyphProps {
  asset: string;
  size?: number;
  /** Network tag, e.g. "TRC20". Rendered as a corner chip. */
  network?: string;
}

/** Deterministic fallback hue for assets with no entry above. */
function fallbackColor(asset: string): string {
  let hash = 0;
  for (let i = 0; i < asset.length; i++) hash = (hash * 31 + asset.charCodeAt(i)) % 360;
  return `hsl(${hash}, 62%, 55%)`;
}

export function AssetGlyph({ asset, size = 44, network }: AssetGlyphProps) {
  const { c } = useTheme();
  const key = String(asset ?? '').toUpperCase();
  const image = COIN_IMAGE[key];
  const meta = ASSET_META[key];
  const color = meta?.color ?? fallbackColor(key);

  return (
    <View style={{ width: size, height: size }}>
      {image ? (
        <Image
          source={image}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          contentFit="contain"
          // Bundled asset, so it's already decoded — no fade needed, and a
          // transition here makes lists visibly shimmer while scrolling.
          transition={0}
          accessibilityLabel={`${meta?.name ?? key} logo`}
        />
      ) : (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: `${color}1F`,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text
            variant="subheading"
            color={color}
            style={{ fontSize: Math.round(size * 0.44), lineHeight: Math.round(size * 0.52) }}
            allowFontScaling={false}
          >
            {meta?.mark ?? key.slice(0, 1)}
          </Text>
        </View>
      )}

      {network ? (
        <View
          style={{
            position: 'absolute',
            bottom: -2,
            right: -6,
            backgroundColor: c.surfaceOverlay,
            borderRadius: 999,
            paddingHorizontal: 5,
            paddingVertical: 2,
            borderWidth: 2,
            borderColor: c.primaryBackground,
          }}
        >
          <Text variant="ticker" color="secondaryText" style={{ fontSize: 8 }}>
            {network}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default AssetGlyph;
