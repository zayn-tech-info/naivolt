/**
 * Welcome — onboarding.
 *
 * The hero is the product's actual proposition, stated as arithmetic:
 *
 *     ₮ 100.00  USDT
 *     ↓
 *     ₦ 153,000
 *
 * Not an illustration of a wallet, not a shield icon over the word "Secure".
 * The one thing a Nigerian user weighing this app against Breet or a Telegram
 * trader wants to know is what their coins turn into and how fast, so the first
 * screen answers it in the same mono numerals the rest of the app uses. The type
 * treatment carries the message and there is no decoration around it.
 *
 * Progress is a segmented hairline rather than dots. Dots are the default choice
 * for any carousel; the hairline reuses the motif established by the quote timer
 * and deposit tracker, so by the time someone sees a rate expiring they've
 * already learned what a filling bar means here.
 *
 * Three slides, not four. The previous version had a fourth explaining the
 * manual screenshot flow that v2 removes, and onboarding length is inversely
 * proportional to how much of it gets read.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Pressable,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTheme } from '@/design';
import { Button, Money, Text } from '@/components/ui';
import { ONBOARDING_KEY } from '@/services/sessionReset';

const SCREEN_WIDTH = Dimensions.get('window').width;

interface Slide {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  /** The figure that carries the slide. */
  figure: 'conversion' | 'speed' | 'custody';
}

const SLIDES: Slide[] = [
  {
    id: 'rate',
    eyebrow: 'Live rate',
    title: 'Your crypto, in naira',
    body: 'Sell USDT, BTC, ETH and more at a rate you lock before you commit. What you see is what lands.',
    figure: 'conversion',
  },
  {
    id: 'speed',
    eyebrow: 'Payouts',
    title: 'Straight to your bank',
    body: 'Naira goes to your own account, usually within minutes. No middlemen, no waiting on a trader to wake up.',
    figure: 'speed',
  },
  {
    id: 'custody',
    eyebrow: 'Your wallet',
    title: 'An address that stays yours',
    body: 'You get a permanent deposit address on every network you use. Send whenever you like — it never changes.',
    figure: 'custody',
  },
];

export default function WelcomeScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const listRef = useRef<FlatList<Slide>>(null);
  const [index, setIndex] = useState(0);

  // Returning users who already onboarded go straight to the auth screen.
  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_KEY)
      .then((done) => {
        if (done === 'yes') router.replace('/register');
      })
      .catch(() => {});
  }, [router]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH));
  }, []);

  const finish = useCallback(() => {
    AsyncStorage.setItem(ONBOARDING_KEY, 'yes').catch(() => {});
    router.push('/register');
  }, [router]);

  const next = useCallback(() => {
    if (index < SLIDES.length - 1) {
      listRef.current?.scrollToIndex({ index: index + 1, animated: true });
    } else {
      finish();
    }
  }, [index, finish]);

  const isLast = index === SLIDES.length - 1;

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={{ flex: 1, backgroundColor: c.primaryBackground }}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'flex-end',
          paddingHorizontal: space.roomy,
          height: 44,
          alignItems: 'center',
        }}
      >
        {!isLast ? (
          <Pressable onPress={finish} hitSlop={12} accessibilityRole="button">
            <Text variant="label" color="tertiaryText">
              Skip
            </Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        ref={listRef}
        data={SLIDES}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        renderItem={({ item }) => <SlideView slide={item} />}
        getItemLayout={(_, i) => ({
          length: SCREEN_WIDTH,
          offset: SCREEN_WIDTH * i,
          index: i,
        })}
      />

      <View style={{ paddingHorizontal: space.roomy, gap: space.roomy }}>
        <Progress count={SLIDES.length} active={index} />

        <Button
          title={isLast ? 'Create an account' : 'Next'}
          onPress={next}
          iconRight={isLast ? 'arrow-forward' : 'chevron-forward'}
          size="lg"
          fullWidth
        />

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 6,
            paddingBottom: space.snug,
          }}
        >
          <Text variant="bodySmall" color="tertiaryText">
            Already have an account?
          </Text>
          {/* Same destination as "Create an account" — signing in and signing up
              are one screen now. */}
          <Pressable onPress={finish} hitSlop={8} accessibilityRole="button">
            <Text variant="action" color="primaryAccent">
              Sign in
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

function SlideView({ slide }: { slide: Slide }) {
  const { space } = useTheme();

  return (
    <View
      style={{
        width: SCREEN_WIDTH,
        paddingHorizontal: space.roomy,
        justifyContent: 'center',
        flex: 1,
      }}
    >
      <View style={{ minHeight: 190, justifyContent: 'center' }}>
        <Figure kind={slide.figure} />
      </View>

      <Text variant="eyebrow" color="primaryAccent" style={{ marginTop: space.major }}>
        {slide.eyebrow}
      </Text>
      <Text variant="title" style={{ marginTop: space.snug }}>
        {slide.title}
      </Text>
      <Text variant="body" color="secondaryText" style={{ marginTop: space.base, maxWidth: 320 }}>
        {slide.body}
      </Text>
    </View>
  );
}

/**
 * The slide's visual. Each is built from type and hairlines rather than
 * illustration — the app has no illustration language, and inventing one for
 * three onboarding screens would be the only place it ever appeared.
 */
function Figure({ kind }: { kind: Slide['figure'] }) {
  const { c, space, radius } = useTheme();

  if (kind === 'conversion') {
    return (
      <Animated.View entering={FadeIn.duration(400)} style={{ gap: space.base }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.snug }}>
          <Money value={100} currency="none" suffix="USDT" variant="figure" color="secondaryText" />
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
          <View style={{ height: 1, width: 28, backgroundColor: c.border }} />
          <Ionicons name="arrow-down" size={15} color={c.primaryAccent} />
          <Text variant="caption" color="tertiaryText">
            at ₦1,530 / USDT
          </Text>
        </View>

        <Money value={153000} variant="display" whole />
      </Animated.View>
    );
  }

  if (kind === 'speed') {
    return (
      <Animated.View entering={FadeIn.duration(400)} style={{ gap: space.comfy }}>
        <Money value={150000} variant="display" whole />
        <View style={{ gap: space.snug }}>
          <Text variant="ticker" color="positive">
            SETTLED IN 2 MIN 14 SEC
          </Text>
          {/* A filled bar — the same language as the deposit tracker. */}
          <View
            style={{
              height: 3,
              borderRadius: radius.chip,
              backgroundColor: c.surfaceElevated,
              overflow: 'hidden',
            }}
          >
            <View style={{ width: '100%', height: '100%', backgroundColor: c.positive }} />
          </View>
          <Text variant="caption" color="tertiaryText">
            GTBank ···4821
          </Text>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(400)} style={{ gap: space.base }}>
      <Text variant="eyebrow" color="tertiaryText">
        Your USDT · TRC-20 address
      </Text>
      <View
        style={{
          backgroundColor: c.surface,
          borderRadius: radius.field,
          padding: space.comfy,
        }}
      >
        <Text variant="code" color="primaryText">
          TQn9 Y2kh EsLJ W1Ch VWFM SMeR Dow5 KcbL SE
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="infinite-outline" size={14} color={c.primaryAccent} />
        <Text variant="caption" color="tertiaryText">
          Permanent — reuse it for every deposit
        </Text>
      </View>
    </Animated.View>
  );
}

/** Segmented hairline progress. The active segment widens and takes the accent. */
function Progress({ count, active }: { count: number; active: number }) {
  const { space } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 5, paddingHorizontal: space.tight }}>
      {Array.from({ length: count }).map((_, i) => (
        <Segment key={i} active={i === active} />
      ))}
    </View>
  );
}

function Segment({ active }: { active: boolean }) {
  const { c, motion, radius } = useTheme();
  const progress = useSharedValue(active ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(active ? 1 : 0, { duration: motion.duration.base });
  }, [active, progress, motion]);

  const style = useAnimatedStyle(() => ({
    flexGrow: 1 + progress.value * 2.2,
    backgroundColor: progress.value > 0.5 ? c.primaryAccent : c.borderLight,
  }));

  return <Animated.View style={[{ height: 3, borderRadius: radius.chip }, style]} />;
}
