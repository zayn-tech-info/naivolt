/**
 * CopyField — a wallet address.
 *
 * The highest-stakes read-only string in the app. Getting it wrong loses money
 * permanently, so the treatment is built around verification:
 *
 *  - mono, so every character is the same width and a transposition is visible
 *  - broken into groups, because people verify addresses by comparing the head
 *    and tail against their wallet, and an unbroken 42-character run defeats that
 *  - copy is the primary action and confirms explicitly, since a silent copy
 *    leaves people unsure whether to paste or type it manually
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Surface } from './Surface';
import { Text } from './Text';
import { useToast } from './Toast';

export interface CopyFieldProps {
  value: string;
  label?: string;
  /** Break the string into space-separated groups of this length. */
  groupSize?: number;
  /** Collapse the middle instead of wrapping. For long hashes in tight rows. */
  truncate?: boolean;
  toastMessage?: string;
  /**
   * `accent` keeps the brand tint on the copy control.
   * `neutral` is for high-stakes surfaces that reserve colour for danger only.
   */
  tone?: 'accent' | 'neutral';
}

function group(value: string, size: number): string {
  if (!size) return value;
  return value.replace(new RegExp(`(.{${size}})`, 'g'), '$1 ').trim();
}

function middleTruncate(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}···${value.slice(-tail)}`;
}

export function CopyField({
  value,
  label,
  groupSize = 4,
  truncate = false,
  toastMessage = 'Address copied',
  tone = 'accent',
}: CopyFieldProps) {
  const { c, space, radius, minTouch } = useTheme();
  const { show } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(value);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setCopied(true);
    show(toastMessage, 'positive');
    setTimeout(() => setCopied(false), 1800);
  }, [value, show, toastMessage]);

  const display = truncate ? middleTruncate(value) : group(value, groupSize);
  const iconBg = copied
    ? c.positiveDim
    : tone === 'neutral'
      ? c.surfaceElevated
      : c.accentDim;
  const iconFg = copied
    ? c.positive
    : tone === 'neutral'
      ? c.primaryText
      : c.primaryAccent;

  return (
    <View>
      {label ? (
        <Text variant="eyebrow" color="tertiaryText" style={{ marginBottom: space.snug }}>
          {label}
        </Text>
      ) : null}

      <Surface
        level={0}
        onPress={handleCopy}
        padding={space.comfy}
        radiusToken="field"
        style={{
          backgroundColor: c.surfaceSunken,
          borderWidth: 1,
          borderColor: copied ? c.positive : c.hairline,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.base,
          minHeight: minTouch + space.snug,
        }}
      >
        <Text variant="code" style={{ flex: 1, letterSpacing: 0.4 }} selectable>
          {display}
        </Text>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: radius.control,
            backgroundColor: iconBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={iconFg} />
        </View>
      </Surface>
    </View>
  );
}

export default CopyField;
