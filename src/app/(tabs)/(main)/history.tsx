/**
 * Activity.
 *
 * One reverse-chronological feed of everything that moved, grouped by day.
 * Restyled to match the sharp Convert / Sell / Deposit address system.
 */

import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/design';
import {
  EmptyState,
  Screen,
  SegmentedControl,
  Skeleton,
  Stagger,
  Text,
  TopLevelHeader,
} from '@/components/ui';
import { ActivityRow } from '@/components/activity/ActivityRow';
import { useActivity } from '@/hooks/useExchange';
import type { ActivityItem } from '@/services/v2/types';

type Filter = 'all' | 'in' | 'out';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in', label: 'Received' },
  { value: 'out', label: 'Sent' },
];


/** Day label for a group header. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';

  return date.toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : null),
  });
}

function groupByDay(items: ActivityItem[]): { day: string; items: ActivityItem[] }[] {
  const groups: { day: string; items: ActivityItem[] }[] = [];
  for (const item of items) {
    const day = dayLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

export default function ActivityScreen() {
  const router = useRouter();
  const { c, radius, space } = useTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);

  const activity = useActivity();

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await activity.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [activity]);

  const items = useMemo(() => activity.data?.items ?? [], [activity.data?.items]);

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'in') return items.filter((i) => i.kind === 'deposit' || i.kind === 'giftcard');
    return items.filter((i) => i.kind === 'payout' || i.kind === 'sell');
  }, [items, filter]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  const totalOut = useMemo(
    () =>
      items
        .filter((i) => i.kind === 'payout' && (i.status === 'settled' || i.status === 'processing'))
        .reduce((sum, i) => sum + Number(i.amount), 0),
    [items]
  );

  return (
    <Screen tabBarClearance refreshing={refreshing} onRefresh={onRefresh}>
      <TopLevelHeader
        title="Activity"
        supportingText={
          !activity.isLoading && totalOut > 0
            ? `${Number(totalOut).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })} withdrawn to your bank`
            : 'Deposits, sales, and withdrawals in one place'
        }
      />

      <View style={{ marginTop: space.comfy }}>
        <SegmentedControl segments={FILTERS} value={filter} onChange={setFilter} />
      </View>

      {activity.isLoading ? (
        <View
          style={{
            marginTop: space.section,
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: c.hairline,
            backgroundColor: c.surface,
            padding: space.comfy,
            gap: space.comfy,
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.comfy }}>
              <Skeleton width={36} height={36} radius={18} />
              <View style={{ flex: 1, gap: space.tight }}>
                <Skeleton width={120} height={13} />
                <Skeleton width={80} height={11} />
              </View>
              <Skeleton width={72} height={15} />
            </View>
          ))}
        </View>
      ) : filtered.length === 0 ? (
        <View style={{ marginTop: space.section }}>
          <EmptyState
            icon="receipt-outline"
            title={filter === 'all' ? 'Nothing here yet' : 'Nothing matches that filter'}
            body={
              filter === 'all'
                ? 'Your deposits, sales and withdrawals will show up here.'
                : 'Try a different filter.'
            }
            actionLabel={filter === 'all' ? 'Deposit crypto' : undefined}
            onAction={filter === 'all' ? () => router.push('/deposit') : undefined}
          />
        </View>
      ) : (
        groups.map((group, gi) => (
          <Stagger key={group.day} index={Math.min(gi, 4)}>
            <View style={{ marginTop: space.section, gap: space.base }}>
              <Text variant="eyebrow" color="tertiaryText">
                {group.day}
              </Text>
              <View
                style={{
                  borderRadius: radius.card,
                  borderWidth: 1,
                  borderColor: c.hairline,
                  backgroundColor: c.surface,
                  overflow: 'hidden',
                  paddingHorizontal: space.comfy,
                }}
              >
                {group.items.map((item, i) => (
                  <ActivityRow key={item.id} item={item} last={i === group.items.length - 1} />
                ))}
              </View>
            </View>
          </Stagger>
        ))
      )}
    </Screen>
  );
}
