/**
 * Receipt — one transaction in full.
 *
 * Tapping a row in Activity previously did nothing, which left the app with no
 * answer to the two questions people actually open a history for: "where is my
 * money right now" and "what do I quote when I contact support".
 *
 * The timeline is the spine of the screen rather than a status badge, because
 * "pending" is not an answer — a user waiting on a transfer wants to know which
 * step it's stuck on. Each kind has its own real sequence (a deposit confirms on
 * chain, a gift card is reviewed by a person, a payout settles at a bank), so
 * they're not flattened into one generic three-dot progress bar.
 *
 * The screen polls itself while the transaction is in flight and stops once it
 * settles. Someone sitting on a pending payout shouldn't have to pull to refresh
 * to find out it landed.
 */

import { useCallback } from 'react';
import { Linking, Share, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  AssetGlyph,
  Button,
  CopyField,
  EmptyState,
  Money,
  Screen,
  Skeleton,
  StatusBadge,
  Stagger,
  Surface,
  Text,
} from '@/components/ui';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { useActivityDetail } from '@/hooks/useExchange';
import type { TimelineStep } from '@/services/v2/types';

const KIND_TITLE: Record<string, string> = {
  deposit: 'Crypto received',
  sell: 'Crypto sold',
  giftcard: 'Gift card',
  payout: 'Sent to bank',
  reversal: 'Reversed',
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ActivityDetailScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data, isLoading, isError } = useActivityDetail(id);

  const share = useCallback(() => {
    if (!data) return;
    const lines = [
      KIND_TITLE[data.kind] ?? 'Transaction',
      `Amount: ₦${Number(data.ngnValue ?? data.amount).toLocaleString('en-NG')}`,
      `Status: ${data.status}`,
      `Date: ${formatWhen(data.createdAt)}`,
      data.reference ? `Reference: ${data.reference}` : null,
    ].filter(Boolean);
    Share.share({ message: lines.join('\n') }).catch(() => {});
  }, [data]);

  if (isLoading) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader onBack={() => router.back()} />
        <View style={{ alignItems: 'center', gap: space.base, marginTop: space.roomy }}>
          <Skeleton width={56} height={56} radius={28} />
          <Skeleton width={200} height={34} radius={8} />
          <Skeleton width={120} height={16} radius={6} />
        </View>
        <Skeleton width="100%" height={160} radius={16} style={{ marginTop: space.section }} />
        <Skeleton width="100%" height={200} radius={16} style={{ marginTop: space.base }} />
      </Screen>
    );
  }

  if (isError || !data) {
    return (
      <Screen edges={['top']}>
        <ScreenHeader onBack={() => router.back()} />
        <View style={{ marginTop: space.major }}>
          <EmptyState
            icon="help-circle-outline"
            title="Transaction not found"
            body="We couldn’t load this one. It may have been removed."
            actionLabel="Go back"
            onAction={() => router.back()}
          />
        </View>
      </Screen>
    );
  }

  const isNaira = data.asset === 'NGN';
  const failed = !!data.failureReason;

  return (
    <Screen edges={['top']}>
      <ScreenHeader onBack={() => router.back()} />

      {/* The headline: what moved, how much, and where it stands. */}
      <Stagger index={0}>
        <View style={{ alignItems: 'center', gap: space.snug, paddingVertical: space.roomy }}>
          <AssetGlyph asset={data.asset} size={52} />

          <Text variant="label" color="tertiaryText" style={{ marginTop: space.tight }}>
            {KIND_TITLE[data.kind] ?? 'Transaction'}
          </Text>

          <Money
            value={Number(data.amount)}
            currency={isNaira ? 'NGN' : 'none'}
            suffix={isNaira ? undefined : data.asset}
            maxFractionDigits={isNaira ? 2 : 8}
            variant="display"
          />

          {/* Naira equivalent, for crypto rows where the amount above is a coin. */}
          {!isNaira && data.ngnValue ? (
            <Money
              value={Number(data.ngnValue)}
              variant="amount"
              color="secondaryText"
            />
          ) : null}

          <View style={{ marginTop: space.snug }}>
            <StatusBadge status={data.status} />
          </View>
        </View>
      </Stagger>

      {failed ? (
        <Stagger index={1}>
          <Surface
            level={1}
            accentEdge={c.negative}
            style={{ flexDirection: 'row', gap: space.snug, marginBottom: space.base }}
          >
            <Ionicons name="alert-circle" size={17} color={c.negative} />
            <Text variant="bodySmall" color="secondaryText" style={{ flex: 1 }}>
              {data.failureReason}
            </Text>
          </Surface>
        </Stagger>
      ) : null}

      {data.timeline?.length ? (
        <Stagger index={2}>
          <Surface level={1} style={{ gap: 0 }}>
            {data.timeline.map((step, i) => (
              <TimelineRow
                key={step.label}
                step={step}
                last={i === data.timeline!.length - 1}
              />
            ))}
          </Surface>
        </Stagger>
      ) : null}

      <Stagger index={3}>
        <Surface level={1} padding={0} style={{ marginTop: space.base, paddingHorizontal: space.comfy }}>
          <Fact label="Date" value={formatWhen(data.createdAt)} />

          {data.bankName ? (
            <Fact label="To" value={`${data.bankName} ${data.accountNumber ?? ''}`.trim()} />
          ) : null}
          {data.accountName ? <Fact label="Account name" value={data.accountName} /> : null}

          {data.brandName ? <Fact label="Card" value={data.brandName} /> : null}
          {data.faceValue ? (
            <Fact label="Face value" value={`${data.currency ?? ''} ${data.faceValue}`.trim()} />
          ) : null}

          {data.network ? <Fact label="Network" value={data.network} /> : null}
          {data.confirmations != null && data.minConfirmations != null ? (
            <Fact
              label="Confirmations"
              value={`${data.confirmations} of ${data.minConfirmations}`}
            />
          ) : null}

          {data.rate ? (
            <Fact label="Rate" value={`₦${Number(data.rate).toLocaleString('en-NG')}`} />
          ) : null}
          {data.fee != null ? (
            <Fact
              label="Fee"
              value={Number(data.fee) === 0 ? 'Free' : `₦${Number(data.fee).toLocaleString('en-NG')}`}
            />
          ) : null}

          <Fact label="Reference" value={data.reference ?? '—'} mono last={!data.txHash} />
        </Surface>
      </Stagger>

      {/* The on-chain proof, given its own block — it's long, and it's the one
          value a user may need to paste somewhere else. */}
      {data.txHash ? (
        <Stagger index={4}>
          <View style={{ marginTop: space.base }}>
            <CopyField
              value={data.txHash}
              label="Transaction hash"
              groupSize={0}
              truncate
              toastMessage="Transaction hash copied"
            />
            {data.explorerUrl ? (
              <Button
                title="View on explorer"
                variant="ghost"
                size="sm"
                iconRight="open-outline"
                onPress={() => Linking.openURL(data.explorerUrl!).catch(() => {})}
                style={{ marginTop: space.snug, alignSelf: 'flex-start' }}
              />
            ) : null}
          </View>
        </Stagger>
      ) : null}

      <Button
        title="Share receipt"
        variant="secondary"
        icon="share-outline"
        onPress={share}
        fullWidth
        style={{ marginTop: space.roomy }}
      />
    </Screen>
  );
}

/**
 * One timeline step. The connector between dots is drawn only when a step
 * follows, so the line stops at the last state rather than trailing into space.
 */
function TimelineRow({ step, last }: { step: TimelineStep; last: boolean }) {
  const { c, space } = useTheme();

  const tone =
    step.state === 'failed'
      ? c.negative
      : step.state === 'done'
        ? c.positive
        : step.state === 'current'
          ? c.warning
          : c.quaternaryText;

  const filled = step.state === 'done' || step.state === 'failed' || step.state === 'current';

  return (
    <View style={{ flexDirection: 'row', gap: space.base }}>
      {/* Rail */}
      <View style={{ alignItems: 'center', width: 18 }}>
        <View
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            marginTop: 4,
            backgroundColor: filled ? tone : 'transparent',
            borderWidth: filled ? 0 : 1.5,
            borderColor: c.borderLight,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {step.state === 'failed' ? (
            <Ionicons name="close" size={8} color={c.buttonTextOnAccent} />
          ) : null}
        </View>
        {!last ? (
          <View
            style={{
              flex: 1,
              width: 1.5,
              minHeight: 26,
              backgroundColor: step.state === 'done' ? c.positive : c.border,
            }}
          />
        ) : null}
      </View>

      <View style={{ flex: 1, paddingBottom: last ? 0 : space.comfy }}>
        <Text
          variant="subheading"
          color={step.state === 'pending' ? 'tertiaryText' : 'primaryText'}
        >
          {step.label}
        </Text>
        {step.at ? (
          <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
            {formatWhen(step.at)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Fact({
  label,
  value,
  mono = false,
  last = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
}) {
  const { c, space } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.base,
        paddingVertical: space.base,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <Text variant="bodySmall" color="secondaryText">
        {label}
      </Text>
      <Text
        variant={mono ? 'code' : 'amountSmall'}
        style={{ flexShrink: 1, textAlign: 'right' }}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}
