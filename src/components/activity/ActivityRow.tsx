/**
 * ActivityRow — one line of history.
 *
 * Direction on the glyph, magnitude in mono, outcome in status colour.
 * Spacing and type match the sharp Sell / Convert list language.
 */

import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { AssetGlyph, Money, StatusBadge, Text } from '@/components/ui';
import type { ActivityItem } from '@/services/v2/types';

const KIND_LABEL: Record<ActivityItem['kind'], string> = {
  deposit: 'Received',
  sell: 'Sold',
  giftcard: 'Gift card',
  payout: 'Sent to bank',
  reversal: 'Reversed',
};

function isInbound(kind: ActivityItem['kind']): boolean {
  return kind === 'deposit' || kind === 'giftcard';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
}

export function ActivityRow({
  item,
  last = false,
}: {
  item: ActivityItem;
  onPress?: () => void;
  last?: boolean;
}) {
  const { c, radius, space } = useTheme();
  const inbound = isInbound(item.kind);
  const isNaira = item.asset === 'NGN';

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.comfy,
        paddingVertical: space.comfy,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <View>
        <AssetGlyph asset={item.asset} size={36} />
        <View
          style={{
            position: 'absolute',
            bottom: -2,
            right: -2,
            width: 16,
            height: 16,
            borderRadius: radius.chip,
            backgroundColor: c.surface,
            borderWidth: 1,
            borderColor: c.hairline,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={inbound ? 'arrow-down' : 'arrow-up'}
            size={9}
            color={inbound ? c.positive : c.tertiaryText}
          />
        </View>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="subheading" numberOfLines={1}>
          {KIND_LABEL[item.kind]}
          {!isNaira ? ` ${item.asset}` : ''}
        </Text>
        <Text variant="caption" color="tertiaryText" numberOfLines={1} style={{ marginTop: 2 }}>
          {item.detail ? `${item.detail} · ` : ''}
          {relativeTime(item.createdAt)}
        </Text>
      </View>

      <View style={{ alignItems: 'flex-end', gap: space.tight }}>
        <Money
          value={Number(item.amount)}
          currency={isNaira ? 'NGN' : 'none'}
          suffix={isNaira ? undefined : item.asset}
          maxFractionDigits={isNaira ? 2 : 6}
          color={inbound ? 'positive' : 'primaryText'}
        />
        <StatusBadge status={item.status} />
      </View>
    </View>
  );
}

export default ActivityRow;
