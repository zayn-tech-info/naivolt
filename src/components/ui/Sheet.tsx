/**
 * Sheet — a bottom sheet.
 *
 * Built for choices that belong *to* the screen that raised them. Pushing a
 * whole page for a two-option list loses the context the user was just looking
 * at; a sheet keeps the originating screen visible behind the scrim, so
 * "which network?" reads as a question about the coin still on screen rather
 * than as a new destination.
 *
 * The animation is hand-driven rather than `Modal animationType="slide"`,
 * because that slides the scrim up with the panel — the backdrop has to fade
 * while the panel travels, or the whole screen appears to lurch.
 *
 * Unmounting is deferred until the exit animation finishes. Dropping the modal
 * the instant `visible` flips to false makes the sheet vanish rather than
 * dismiss, which reads as a crash on a screen that handles money.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/design';
import { Text } from './Text';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  /** Supporting line under the title. */
  subtitle?: string;
  children: ReactNode;
}

export function Sheet({ visible, onClose, title, subtitle, children }: SheetProps) {
  const { c, radius, space, motion } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();

  // Mount lags `visible` on the way out so the exit animation can play.
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(0);

  useEffect(() => {
    const duration = reduceMotion ? 0 : motion.duration.base;

    if (visible) {
      setMounted(true);
      progress.value = withTiming(1, { duration });
      return;
    }

    progress.value = withTiming(0, { duration }, (finished) => {
      if (finished) runOnJS(setMounted)(false);
    });
  }, [visible, progress, motion, reduceMotion]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  // Travels a fraction of the viewport rather than its own height: the panel is
  // measured after layout, and keying the transform to it makes the first frame
  // jump once the real height arrives.
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * height * 0.4 }],
    opacity: progress.value,
  }));

  if (!mounted) return null;

  return (
    <Modal
      transparent
      visible
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: 'rgba(0, 0, 0, 0.55)' },
            backdropStyle,
          ]}
        >
          <Pressable
            style={{ flex: 1 }}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
        </Animated.View>

        <Animated.View
          style={[
            {
              maxHeight: height * 0.85,
              backgroundColor: c.surfaceElevated,
              borderTopLeftRadius: radius.sheet,
              borderTopRightRadius: radius.sheet,
              paddingHorizontal: space.roomy,
              paddingTop: space.base,
              paddingBottom: insets.bottom + space.roomy,
            },
            panelStyle,
          ]}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.borderLight,
              marginBottom: space.comfy,
            }}
          />

          {title ? (
            <View style={{ marginBottom: space.base, gap: 3 }}>
              <Text variant="subheading">{title}</Text>
              {subtitle ? (
                <Text variant="bodySmall" color="secondaryText">
                  {subtitle}
                </Text>
              ) : null}
            </View>
          ) : null}

          <ScrollView
            bounces={false}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

export default Sheet;
