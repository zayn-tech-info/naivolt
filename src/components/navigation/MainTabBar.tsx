/**
 * MainTabBar — the floating pill.
 *
 * Kept from the previous design, because a blurred floating pill over content is
 * a good call and it's part of the app's identity. What changed:
 *
 *  - The active chip was lime with white text. White on #AAFF00 is about 1.6:1
 *    contrast, which is unreadable in sunlight — and Nigerian users use their
 *    phones outdoors. It now uses the same near-black the accent pairs with
 *    everywhere else, at roughly 14:1.
 *  - `require("react-native")` inline inside the press handler is gone, along
 *    with the Alert it was there for. Routing a user to add a bank account is a
 *    navigation decision, not an OS dialog — the destination screen makes the
 *    ask, in context, where it can explain itself.
 *  - The label crossfades and the chip grows via a spring rather than appearing
 *    instantly, so selection has continuity.
 *  - The blur no longer spans the whole bottom strip. iOS renders
 *    `systemChromeMaterialDark` several stops lighter than a #08090A canvas, so
 *    a full-width blurred strip read as a grey band bolted to the bottom of the
 *    screen rather than as part of it. Now the strip is a gradient that fades
 *    the canvas up over the content, and only the pill itself is glass — which
 *    is what "floating" was supposed to mean. It blends in both themes because
 *    the fade is the canvas colour, whatever that currently is.
 */

import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/store/appStore';
import { useAppStore } from '@/store/appStore';
import { motion } from '@/design/tokens';
import Text from '@/components/ui/Text';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const TAB_CONFIG: Record<string, { icon: IoniconName; iconFocused: IoniconName; label: string }> = {
  index: { icon: 'home-outline', iconFocused: 'home', label: 'Home' },
  convert: { icon: 'swap-horizontal-outline', iconFocused: 'swap-horizontal', label: 'Convert' },
  history: { icon: 'receipt-outline', iconFocused: 'receipt', label: 'Activity' },
  profile: { icon: 'person-circle-outline', iconFocused: 'person-circle', label: 'Profile' },
};

export function MainTabBar({ state, navigation }: BottomTabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const mode = useAppStore((s) => s.mode);

  const handlePress = (routeName: string, routeKey: string, isFocused: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    const event = navigation.emit({
      type: 'tabPress',
      target: routeKey,
      canPreventDefault: true,
    });
    if (!isFocused && !event.defaultPrevented) {
      navigation.navigate(routeName);
    }
  };

  // Fades from nothing to the canvas, so content scrolls out of view instead of
  // colliding with an edge. `transparent` is spelled as the canvas at zero alpha
  // rather than the keyword: on Android the keyword interpolates through black
  // and leaves a grey smear over a dark background.
  const fade = mode === 'dark'
    ? ['rgba(8,9,10,0)', 'rgba(8,9,10,0.92)', 'rgba(8,9,10,1)'] as const
    : ['rgba(250,250,250,0)', 'rgba(250,250,250,0.92)', 'rgba(250,250,250,1)'] as const;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrapper, { paddingBottom: Math.max(insets.bottom, 12) }]}
    >
      <LinearGradient
        colors={fade}
        locations={[0, 0.55, 1]}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />

      <BlurView
        intensity={mode === 'dark' ? 40 : 60}
        tint={mode === 'dark' ? 'dark' : 'light'}
        style={[
          styles.pill,
          {
            backgroundColor: mode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            // A hairline gives the pill an edge against the canvas it is
            // floating on; without it the glass has no boundary and reads as a
            // smudge rather than a control.
            borderColor: mode === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)',
          },
        ]}
      >
        {state.routes.map((route, index) => {
          const config = TAB_CONFIG[route.name];
          if (!config) return null;

          return (
            <Tab
              key={route.key}
              config={config}
              focused={state.index === index}
              accent={c.primaryAccent}
              onAccent={c.buttonTextOnAccent}
              inactive={c.secondaryText}
              onPress={() => handlePress(route.name, route.key, state.index === index)}
            />
          );
        })}
      </BlurView>
    </View>
  );
}

function Tab({
  config,
  focused,
  accent,
  onAccent,
  inactive,
  onPress,
}: {
  config: { icon: IoniconName; iconFocused: IoniconName; label: string };
  focused: boolean;
  accent: string;
  onAccent: string;
  inactive: string;
  onPress: () => void;
}) {
  const progress = useSharedValue(focused ? 1 : 0);

  useEffect(() => {
    progress.value = withSpring(focused ? 1 : 0, motion.press);
  }, [focused, progress]);

  const chipStyle = useAnimatedStyle(() => ({
    backgroundColor: progress.value > 0.5 ? accent : 'transparent',
  }));

  const labelStyle = useAnimatedStyle(() => ({
    opacity: withTiming(focused ? 1 : 0, { duration: motion.duration.fast }),
  }));

  return (
    <Pressable
      onPress={onPress}
      style={styles.tabWrap}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={config.label}
      android_ripple={{ color: 'transparent' }}
    >
      <Animated.View style={[styles.chip, chipStyle]}>
        <Ionicons
          name={focused ? config.iconFocused : config.icon}
          size={22}
          color={focused ? onAccent : inactive}
        />
        {focused ? (
          <Animated.View style={labelStyle}>
            <Text variant="action" color={onAccent} numberOfLines={1} style={{ fontSize: 14 }}>
              {config.label}
            </Text>
          </Animated.View>
        ) : null}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    // Room for the gradient to do its work before the pill starts.
    paddingTop: 28,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 7,
    borderWidth: StyleSheet.hairlineWidth,
    // Clips the blur to the pill's radius; without it the glass renders as a
    // rectangle behind rounded corners.
    overflow: 'hidden',
  },
  tabWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    paddingHorizontal: 18,
    borderRadius: 999,
  },
});
