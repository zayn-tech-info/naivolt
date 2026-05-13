import { useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  FlatList,
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '@/constants/theme';
import { Colors } from '@/constants/colors';
import { useColors } from '@/store/appStore';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const SLIDES = [
  {
    id: 'hero',
    icon: 'flash' as const,
    iconColor: c.primaryAccent,
    title: 'Got Crypto?\nGet Naira.',
    titleAccent: 'Get Naira.',
    subtitle: 'The smartest way to convert crypto to Naira.\nFast, simple, secure.',
    bullets: [
      'Real-time rates, zero hidden charges',
      'Supports USDT, BTC, ETH and more',
      'Naira paid straight to your bank',
    ],
  },
  {
    id: 'how',
    icon: 'list-circle' as const,
    iconColor: '#a78bfa',
    title: 'How It Works',
    titleAccent: null,
    subtitle: 'Three steps to turn your crypto into cash.',
    steps: [
      {
        num: '1',
        title: 'Send Crypto',
        desc: 'Copy your unique deposit address and send USDT or BTC from any wallet.',
      },
      {
        num: '2',
        title: 'Upload Proof',
        desc: 'Screenshot your transaction and upload it as payment proof in the app.',
      },
      {
        num: '3',
        title: 'Get Naira',
        desc: 'We verify and send Naira directly to your Nigerian bank account.',
      },
    ],
  },
  {
    id: 'giftcards',
    icon: 'gift' as const,
    iconColor: '#a855f7',
    title: 'Sell Gift Cards\nfor Naira too.',
    titleAccent: 'for Naira too.',
    subtitle: 'Amazon, iTunes, Google Play, Steam and more — all converted to Naira instantly.',
    bullets: [
      'Upload your gift card details & proof',
      'Get the best NGN rates per card',
      'Payout to your bank in minutes',
    ],
  },
];

function Slide({ item, styles, c }: { item: (typeof SLIDES)[number]; styles: ReturnType<typeof createStyles>; c: Colors }) {
  return (
    <View style={[styles.slide, { width: SCREEN_WIDTH }]}>
      <View style={[styles.iconWrap, { borderColor: item.iconColor + '40' }]}>
        <Ionicons name={item.icon} size={48} color={item.iconColor} />
      </View>

      <Text style={styles.slideTitle}>
        {item.titleAccent
          ? item.title.replace(item.titleAccent, '').trim() + '\n'
          : item.title}
        {item.titleAccent && (
          <Text style={[styles.slideTitleAccent, { color: item.iconColor }]}>
            {item.titleAccent}
          </Text>
        )}
      </Text>

      <Text style={styles.slideSubtitle}>{item.subtitle}</Text>

      {'steps' in item && item.steps ? (
        <View style={styles.stepsBlock}>
          {item.steps.map((s) => (
            <View key={s.num} style={styles.stepRow}>
              <View style={[styles.stepCircle, { backgroundColor: item.iconColor }]}>
                <Text style={styles.stepNum}>{s.num}</Text>
              </View>
              <View style={styles.stepText}>
                <Text style={styles.stepTitle}>{s.title}</Text>
                <Text style={styles.stepDesc}>{s.desc}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.bulletsBlock}>
          {'bullets' in item && item.bullets?.map((line, i) => (
            <View key={i} style={styles.bulletRow}>
              <View style={[styles.bulletDot, { backgroundColor: item.iconColor }]} />
              <Text style={styles.bulletText}>{line}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export default function WelcomeScreen() {
  const router = useRouter();
  const c = useColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const flatListRef = useRef<FlatList>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setActiveIndex(index);
  }, []);

  const handleNext = useCallback(() => {
    if (activeIndex < SLIDES.length - 1) {
      flatListRef.current?.scrollToIndex({ index: activeIndex + 1, animated: true });
    } else {
      router.push('/register');
    }
  }, [activeIndex, router]);

  const isLast = activeIndex === SLIDES.length - 1;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.container}>
        {/* Skip */}
        <View style={styles.topBar}>
          <Pressable onPress={() => router.push('/register')} hitSlop={12}>
            <Text style={styles.skipText}>Skip</Text>
          </Pressable>
        </View>

        {/* Slides */}
        <FlatList
          ref={flatListRef}
          data={SLIDES}
          keyExtractor={(item) => item.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
          renderItem={({ item }) => <Slide item={item} styles={styles} c={c} />}
          getItemLayout={(_, index) => ({
            length: SCREEN_WIDTH,
            offset: SCREEN_WIDTH * index,
            index,
          })}
        />

        {/* Dots + CTA */}
        <View style={styles.footer}>
          <View style={styles.dots}>
            {SLIDES.map((_, i) => (
              <View
                key={i}
                style={[styles.dot, i === activeIndex && styles.dotActive]}
              />
            ))}
          </View>

          <TouchableOpacity
            activeOpacity={0.85}
            style={styles.primaryButton}
            onPress={handleNext}
          >
            <Text style={styles.primaryButtonText}>
              {isLast ? 'Get Started' : 'Next'}
            </Text>
            <Ionicons
              name={isLast ? 'arrow-forward' : 'chevron-forward'}
              size={20}
              color={c.buttonTextOnAccent}
              style={styles.buttonArrow}
            />
          </TouchableOpacity>

          <View style={styles.loginRow}>
            <Text style={styles.loginPrompt}>Already have an account?</Text>
            <Pressable
              onPress={() => router.push('/login')}
              style={({ pressed }) => [styles.loginLinkWrap, pressed && styles.loginPressed]}
            >
              <Text style={styles.loginLink}>Login</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

function createStyles(c: Colors) {
  return StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: c.primaryBackground,
  },
  container: {
    flex: 1,
  },
  topBar: {
    alignItems: 'flex-end',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  },
  skipText: {
    fontSize: 14,
    fontWeight: '600',
    color: c.secondaryText,
  },
  slide: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    alignItems: 'center',
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 24,
    backgroundColor: c.surface,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.xl,
  },
  slideTitle: {
    fontSize: 32,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 40,
    letterSpacing: -0.5,
    color: c.primaryText,
    marginBottom: theme.spacing.md,
    maxWidth: 300,
  },
  slideTitleAccent: {
    fontWeight: '800',
  },
  slideSubtitle: {
    fontSize: 15,
    color: c.secondaryText,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 300,
    marginBottom: theme.spacing.xl,
  },
  stepsBlock: {
    width: '100%',
    gap: 16,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
    gap: 14,
  },
  stepCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  stepNum: {
    fontSize: 14,
    fontWeight: '800',
    color: '#000',
  },
  stepText: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: c.primaryText,
    marginBottom: 4,
  },
  stepDesc: {
    fontSize: 13,
    color: c.secondaryText,
    lineHeight: 18,
  },
  bulletsBlock: {
    width: '100%',
    gap: 14,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  bulletDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  bulletText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: c.primaryText,
    lineHeight: 22,
  },
  footer: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
    paddingTop: theme.spacing.md,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginBottom: theme.spacing.lg,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.border,
  },
  dotActive: {
    width: 20,
    backgroundColor: c.primaryAccent,
  },
  primaryButton: {
    backgroundColor: c.primaryAccent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
    borderRadius: theme.borderRadius.button,
    marginBottom: theme.spacing.lg,
  },
  primaryButtonText: {
    fontSize: 17,
    fontWeight: '700',
    color: c.buttonTextOnAccent,
    letterSpacing: 0.3,
  },
  buttonArrow: {
    marginLeft: theme.spacing.sm,
  },
  loginRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
  },
  loginPrompt: {
    fontSize: 15,
    color: c.secondaryText,
  },
  loginLinkWrap: {
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.xs,
  },
  loginLink: {
    fontSize: 15,
    fontWeight: '600',
    color: c.primaryAccent,
  },
  loginPressed: {
    opacity: 0.8,
  },
  });
}
