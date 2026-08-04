import { useEffect } from 'react';
import { Image, useWindowDimensions, View, type ImageSourcePropType } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { space } from '@/design';

interface LogoAsset {
  key: string;
  source: ImageSourcePropType;
  size: number;
}

interface LogoRow {
  key: string;
  logos: LogoAsset[];
  direction: 'left' | 'right';
  duration: number;
}

const LOGO_SMALL = space.hero + space.snug;
const LOGO_MEDIUM = space.hero + space.comfy;
const LOGO_LARGE = space.hero + space.section;
const CELL_WIDTH = space.hero + space.major;
const ROW_HEIGHT = space.hero + space.major;
const TRACK_HEIGHT = space.hero * 6;
const MIN_EXPANDED_HEIGHT = TRACK_HEIGHT;
const MAX_EXPANDED_HEIGHT = space.hero * 9;

const ROWS: LogoRow[] = [
  {
    key: 'row-one',
    direction: 'left',
    duration: 28_000,
    logos: [
      { key: 'usdt', source: require('../../../assets/images/coins/usdt.png'), size: LOGO_LARGE },
      { key: 'btc', source: require('../../../assets/images/coins/btc.png'), size: LOGO_MEDIUM },
      { key: 'eth', source: require('../../../assets/images/coins/eth.png'), size: LOGO_LARGE },
      { key: 'matic', source: require('../../../assets/images/coins/matic.png'), size: LOGO_MEDIUM },
      { key: 'usdc', source: require('../../../assets/images/coins/usdc.png'), size: LOGO_SMALL },
    ],
  },
  {
    key: 'row-two',
    direction: 'right',
    duration: 34_000,
    logos: [
      { key: 'bnb', source: require('../../../assets/images/coins/bnb.png'), size: LOGO_MEDIUM },
      { key: 'sol', source: require('../../../assets/images/coins/sol.png'), size: LOGO_LARGE },
      { key: 'dai', source: require('../../../assets/images/coins/dai.png'), size: LOGO_SMALL },
      { key: 'avax', source: require('../../../assets/images/coins/avax.png'), size: LOGO_MEDIUM },
      { key: 'dot', source: require('../../../assets/images/coins/dot.png'), size: LOGO_LARGE },
    ],
  },
  {
    key: 'row-three',
    direction: 'left',
    duration: 30_000,
    logos: [
      { key: 'trx', source: require('../../../assets/images/coins/trx.png'), size: LOGO_MEDIUM },
      { key: 'xrp', source: require('../../../assets/images/coins/xrp.png'), size: LOGO_SMALL },
      { key: 'doge', source: require('../../../assets/images/coins/doge.png'), size: LOGO_LARGE },
      { key: 'ada', source: require('../../../assets/images/coins/ada.png'), size: LOGO_MEDIUM },
      { key: 'link', source: require('../../../assets/images/coins/link.png'), size: LOGO_LARGE },
    ],
  },
];

export function CryptoLogoMarquee() {
  const { height: viewportHeight } = useWindowDimensions();
  const expandedHeight = Math.min(
    Math.max(viewportHeight * 0.45, MIN_EXPANDED_HEIGHT),
    MAX_EXPANDED_HEIGHT,
  );

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: expandedHeight, overflow: 'hidden', justifyContent: 'center' }}
    >
      <View style={{ height: TRACK_HEIGHT, justifyContent: 'space-between' }}>
        {ROWS.map((row) => (
          <MarqueeRow key={row.key} row={row} />
        ))}
      </View>
    </View>
  );
}

function MarqueeRow({ row }: { row: LogoRow }) {
  const reducedMotion = useReducedMotion();
  const distance = CELL_WIDTH * row.logos.length;
  const edgeOffset = CELL_WIDTH / 2;
  const start = row.direction === 'left' ? -edgeOffset : -distance - edgeOffset;
  const end = row.direction === 'left' ? -distance - edgeOffset : -edgeOffset;
  const translateX = useSharedValue(start);

  useEffect(() => {
    cancelAnimation(translateX);
    if (reducedMotion) return () => cancelAnimation(translateX);

    translateX.value = start;
    translateX.value = withRepeat(
      withTiming(end, { duration: row.duration, easing: Easing.linear }),
      -1,
      false,
    );

    return () => cancelAnimation(translateX);
  }, [end, reducedMotion, row.duration, start, translateX]);

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const repeated = [...row.logos, ...row.logos];

  return (
    <View style={{ height: ROW_HEIGHT, justifyContent: 'center', overflow: 'hidden' }}>
      <Animated.View style={[{ flexDirection: 'row', width: distance * 2 }, rowStyle]}>
        {repeated.map((logo, index) => (
          <View
            key={`${logo.key}-${index}`}
            style={{
              width: CELL_WIDTH,
              height: ROW_HEIGHT,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Image
              source={logo.source}
              accessible={false}
              resizeMode="contain"
              style={{ width: logo.size, height: logo.size }}
            />
          </View>
        ))}
      </Animated.View>
    </View>
  );
}
