/**
 * Toast.
 *
 * Replaces `Alert.alert` for feedback. A blocking OS modal is the wrong control
 * for "copied" or "rate refreshed" — it steals focus, can't be styled, and
 * trains people to dismiss dialogs without reading them, which is dangerous in
 * an app where a real confirmation dialog needs to be read.
 *
 * Alerts remain correct for destructive confirmations. This is for
 * acknowledgement.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeInUp, FadeOut, FadeOutUp, useReducedMotion } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Text } from './Text';

type ToastTone = 'neutral' | 'positive' | 'negative' | 'warning';

interface ToastPayload {
  message: string;
  tone?: ToastTone;
}

interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

const DURATION = 2200;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastPayload & { id: number }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const show = useCallback((message: string, tone: ToastTone = 'neutral') => {
    if (timer.current) clearTimeout(timer.current);
    seq.current += 1;
    setToast({ message, tone, id: seq.current });

    if (tone === 'positive') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } else if (tone === 'negative') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    }

    timer.current = setTimeout(() => setToast(null), DURATION);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? <ToastView key={toast.id} {...toast} /> : null}
    </ToastContext.Provider>
  );
}

function ToastView({ message, tone = 'neutral' }: ToastPayload) {
  const { c, radius, space, elevation } = useTheme();
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();

  const icon: Record<ToastTone, React.ComponentProps<typeof Ionicons>['name']> = {
    neutral: 'information-circle',
    positive: 'checkmark-circle',
    negative: 'alert-circle',
    warning: 'warning',
  };

  const fg: Record<ToastTone, string> = {
    neutral: c.secondaryText,
    positive: c.positive,
    negative: c.negative,
    warning: c.warning,
  };

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: insets.top + space.snug,
        left: space.comfy,
        right: space.comfy,
        alignItems: 'center',
      }}
    >
      <Animated.View
        entering={reduceMotion ? FadeIn.duration(120) : FadeInUp.duration(240)}
        exiting={reduceMotion ? FadeOut.duration(100) : FadeOutUp.duration(180)}
        accessibilityLiveRegion="polite"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.snug,
          backgroundColor: c.surfaceOverlay,
          borderRadius: radius.chip,
          paddingVertical: 11,
          paddingHorizontal: space.comfy,
          maxWidth: '100%',
          ...elevation(3),
        }}
      >
        <Ionicons name={icon[tone]} size={16} color={fg[tone]} />
        <Text variant="bodySmall" numberOfLines={2} style={{ flexShrink: 1 }}>
          {message}
        </Text>
      </Animated.View>
    </View>
  );
}

export default ToastProvider;
