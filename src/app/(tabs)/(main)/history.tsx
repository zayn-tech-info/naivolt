/**
 * Activity.
 *
 * One reverse-chronological feed of everything that moved, grouped by day.
 *
 * The previous version split crypto and gift cards behind two tabs. That's the
 * app's internal shape, not the user's: someone asking "where is my money" does
 * not know or care which subsystem handled it, and a split feed means checking
 * two places to answer one question. Filtering is available, but the default
 * shows everything.
 *
 * Day grouping replaces per-row absolute dates. In a list where most entries
 * happened today or yesterday, a date on every row is noise; a sticky-ish day
 * header carries it once and the rows just say the time.
 */

import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/design';
import {
  EmptyState,
  Money,
  Screen,
  SegmentedControl,
  Skeleton,
  Stagger,
  Surface,
  Text,
} from '@/components/ui';
import ActivityRow from '@/components/activity/ActivityRow';
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
    // Only show the year once it stops being obvious.
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
  const { space } = useTheme();
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

  const items = activity.data?.items ?? [];

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'in') return items.filter((i) => i.kind === 'deposit' || i.kind === 'giftcard');
    return items.filter((i) => i.kind === 'payout' || i.kind === 'sell');
  }, [items, filter]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  // Net naira received, so the header answers "how much have I actually taken
  // out" rather than just listing rows.
  const totalOut = useMemo(
    () =>
      items
        .filter((i) => i.kind === 'payout' && (i.status === 'settled' || i.status === 'processing'))
        .reduce((sum, i) => sum + Number(i.amount), 0),
    [items]
  );

  return (
    <Screen tabBarClearance refreshing={refreshing} onRefresh={onRefresh}>
      <View style={{ marginTop: space.snug, marginBottom: space.roomy }}>
        <Text variant="title">Activity</Text>
        {!activity.isLoading && totalOut > 0 ? (
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
            <Money value={totalOut} variant="amountSmall" color="secondaryText" />
            <Text variant="caption" color="tertiaryText">
              withdrawn to your bank
            </Text>
          </View>
        ) : null}
      </View>

      <SegmentedControl segments={FILTERS} value={filter} onChange={setFilter} />

      {activity.isLoading ? (
        <Surface level={1} style={{ marginTop: space.roomy, gap: space.comfy }}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
              <Skeleton width={40} height={40} radius={20} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width={120} height={13} />
                <Skeleton width={80} height={11} />
              </View>
              <Skeleton width={72} height={15} />
            </View>
          ))}
        </Surface>
      ) : filtered.length === 0 ? (
        <View style={{ marginTop: space.roomy }}>
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
            <View style={{ marginTop: space.section }}>
              <Text variant="eyebrow" color="tertiaryText" style={{ marginBottom: space.base }}>
                {group.day}
              </Text>
              <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
                {group.items.map((item, i) => (
                  <ActivityRow
                    key={item.id}
                    item={item}
                    last={i === group.items.length - 1}
                  />
                ))}
              </Surface>
            </View>
          </Stagger>
        ))
      )}
    </Screen>
  );
}
