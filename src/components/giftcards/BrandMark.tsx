/**
 * BrandMark — gift card brand logomark.
 *
 * Prefers a vendored PNG under assets/images/gift-cards/ (keyed by brand slug).
 * Falls back to a remote logoUrl when present, then to a lettermark on a neutral
 * plate — never an arbitrary brand colour, so unknown brands stay legible.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '@/design';
import { Text } from '@/components/ui';


/** Static require map. Metro needs enumerated requires at build time. */
export const GIFT_CARD_LOGO: Record<string, ReturnType<typeof require>> = {
  amazon: require('../../../assets/images/gift-cards/amazon.png'),
  itunes: require('../../../assets/images/gift-cards/itunes.png'),
  steam: require('../../../assets/images/gift-cards/steam.png'),
  'google-play': require('../../../assets/images/gift-cards/google-play.png'),
  playstation: require('../../../assets/images/gift-cards/playstation.png'),
  xbox: require('../../../assets/images/gift-cards/xbox.png'),
  sephora: require('../../../assets/images/gift-cards/sephora.png'),
  nike: require('../../../assets/images/gift-cards/nike.png'),
  netflix: require('../../../assets/images/gift-cards/netflix.png'),
  ebay: require('../../../assets/images/gift-cards/ebay.png'),
  vanilla: require('../../../assets/images/gift-cards/vanilla.png'),
  walmart: require('../../../assets/images/gift-cards/walmart.png'),
};

/**
 * Brands whose local mark is a weak favicon (tiny or indistinct). Replace when
 * proper logomarks are available; the UI still shows them, then falls back to
 * lettermark if decode fails.
 */
export const GIFT_CARD_LOGO_NEEDS_ASSET: string[] = ['ebay', 'vanilla', 'amazon', 'google-play'];

export interface BrandMarkProps {
  name: string;
  slug: string;
  logoUrl?: string | null;
  size?: number;
}

type Phase = 'local' | 'remote' | 'letter';

function initialPhase(slug: string, logoUrl?: string | null): Phase {
  if (GIFT_CARD_LOGO[slug]) return 'local';
  if (logoUrl) return 'remote';
  return 'letter';
}

export function BrandMark({ name, slug, logoUrl, size = 40 }: BrandMarkProps) {
  const { c, radius } = useTheme();
  const local = GIFT_CARD_LOGO[slug];
  const [phase, setPhase] = useState<Phase>(() => initialPhase(slug, logoUrl));

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.card,
        backgroundColor: c.surfaceSunken,
        borderWidth: 1,
        borderColor: c.hairline,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
      accessibilityLabel={`${name} logo`}
    >
      {phase === 'local' && local ? (
        <Image
          source={local}
          style={{ width: size - 8, height: size - 8 }}
          contentFit="contain"
          transition={0}
          onError={() => setPhase(logoUrl ? 'remote' : 'letter')}
        />
      ) : phase === 'remote' && logoUrl ? (
        <Image
          source={{ uri: logoUrl }}
          style={{ width: size - 8, height: size - 8 }}
          contentFit="contain"
          transition={120}
          onError={() => setPhase('letter')}
        />
      ) : (
        <Text variant="subheading" color="secondaryText" allowFontScaling={false}>
          {name.trim().charAt(0).toUpperCase() || '?'}
        </Text>
      )}
    </View>
  );
}

export default BrandMark;
