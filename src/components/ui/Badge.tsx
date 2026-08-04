/**
 * Badge — status only.
 *
 * A transaction's state is the single most-scanned piece of information in the
 * app, so each state gets a distinct hue plus its own word. Colour alone is not
 * enough: roughly 1 in 12 men has a colour vision deficiency, and this badge
 * decides whether someone believes they've been paid.
 */

import { View } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';

export type StatusTone = 'positive' | 'warning' | 'negative' | 'info' | 'neutral';

/** Maps the domain's states onto tones. */
export const STATUS_TONE: Record<string, StatusTone> = {
  paid: 'positive',
  completed: 'positive',
  confirmed: 'positive',
  credited: 'positive',
  settled: 'positive',
  success: 'positive',
  approved: 'positive',

  pending: 'warning',
  processing: 'warning',
  awaiting: 'warning',
  confirming: 'warning',
  reserved: 'warning',
  queued: 'warning',
  reviewing: 'warning',
  detected: 'warning',

  rejected: 'negative',
  failed: 'negative',
  reversed: 'negative',
  expired: 'negative',
  cancelled: 'negative',
};

export interface BadgeProps {
  label: string;
  tone?: StatusTone;
  /** Adds a leading dot — helpful where several badges sit in a column. */
  dot?: boolean;
}

export function Badge({ label, tone = 'neutral', dot = true }: BadgeProps) {
  const { c, radius, space } = useTheme();

  const palette: Record<StatusTone, { fg: string; bg: string }> = {
    positive: { fg: c.positive, bg: c.positiveDim },
    warning: { fg: c.warning, bg: c.warningDim },
    negative: { fg: c.negative, bg: c.negativeDim },
    info: { fg: c.info, bg: c.infoDim },
    neutral: { fg: c.secondaryText, bg: c.surfaceElevated },
  };

  const { fg, bg } = palette[tone];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.tight,
        backgroundColor: bg,
        borderRadius: radius.chip,
        paddingVertical: space.snug,
        paddingHorizontal: space.base,
      }}
    >
      {dot ? (
        <View
          style={{
            width: space.tight,
            height: space.tight,
            borderRadius: radius.chip,
            backgroundColor: fg,
          }}
        />
      ) : null}
      <Text variant="eyebrow" color={fg}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Activity status is quiet metadata, not an action or promotional badge.
 * It keeps the semantic tone while avoiding a filled pill that competes with
 * the transaction amount.
 */
export function StatusBadge({ status }: { status: string }) {
  const { c } = useTheme();
  const key = String(status ?? '').toLowerCase();
  const tone = STATUS_TONE[key] ?? 'neutral';
  /** Success states use the shared positive token (same success ink as deposit flows). */
  const color: Record<StatusTone, string> = {
    positive: c.positive,
    warning: c.warning,
    negative: c.danger,
    info: c.info,
    neutral: c.tertiaryText,
  };

  return (
    <Text variant="caption" color={color[tone]}>
      {key || 'unknown'}
    </Text>
  );
}

export default Badge;
