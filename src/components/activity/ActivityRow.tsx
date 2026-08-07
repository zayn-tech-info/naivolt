/**
 * ActivityRow — one line of history.
 *
 * A single row has to answer three questions at a glance: what happened, how
 * much, and did it land. So direction is carried by the glyph, magnitude by the
 * mono figure, and outcome by the badge — three separate channels, because
 * someone scanning for "did my ₦150,000 arrive" shouldn't have to read a
 * sentence.
 *
 * Sign convention is from the user's side of the screen, not the ledger's: a
 * deposit is money coming in and reads positive, a payout is money leaving and
 * reads negative. The ledger's own signs are inverted for liabilities
 * (ARCHITECTURE.md §5), which is correct accounting and would be nonsense here.
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

/**
 * Direction from the user's perspective. A gift card sale credits naira, so it
 * reads as money in even though the user handed something over.
 */
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
  onPress,
  last = false,
}: {
  item: ActivityItem;
  onPress?: () => void;
  last?: boolean;
}) {
  const { c, space } = useTheme();
  const inbound = isInbound(item.kind);
  const isNaira = item.asset === 'NGN';

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.base,
        paddingVertical: space.base,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <View>
        <AssetGlyph asset={item.asset} size={40} />
        {/* Direction badge on the glyph — readable without parsing the label. */}
        <View
          style={{
            position: 'absolute',
            bottom: -2,
            right: -2,
            width: 17,
            height: 17,
            borderRadius: 9,
            backgroundColor: c.surfaceOverlay,
            borderWidth: 2,
            borderColor: c.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={inbound ? 'arrow-down' : 'arrow-up'}
            size={9}
            color={inbound ? c.positive : c.secondaryText}
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

      <View style={{ alignItems: 'flex-end', gap: 5 }}>
        <Money
          value={Number(isNaira ? item.amount : item.amount)}
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
