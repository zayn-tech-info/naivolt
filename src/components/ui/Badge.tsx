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
import Text from './Text';

export type StatusTone = 'positive' | 'warning' | 'negative' | 'info' | 'neutral';

/** Maps the domain's states onto tones. */
export const STATUS_TONE: Record<string, StatusTone> = {
  paid: 'positive',
  completed: 'positive',
  confirmed: 'positive',
  credited: 'positive',
  settled: 'positive',
  success: 'positive',

  pending: 'warning',
  processing: 'warning',
  awaiting: 'warning',
  confirming: 'warning',
  reserved: 'warning',
  queued: 'warning',

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
        gap: 5,
        alignSelf: 'flex-start',
        backgroundColor: bg,
        borderRadius: radius.chip,
        paddingVertical: 4,
        paddingHorizontal: dot ? space.snug : 10,
      }}
    >
      {dot ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: fg }} /> : null}
      <Text variant="eyebrow" color={fg} style={{ letterSpacing: 0.6, fontSize: 10 }}>
        {label}
      </Text>
    </View>
  );
}

/** Convenience wrapper that resolves a domain status string to its tone. */
export function StatusBadge({ status }: { status: string }) {
  const key = String(status ?? '').toLowerCase();
  return <Badge label={key || 'unknown'} tone={STATUS_TONE[key] ?? 'neutral'} />;
}

export default Badge;
