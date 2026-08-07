/**
 * Deposit — the address.
 *
 * The screen where a mistake is unrecoverable. Sending USDT to a TRC-20 address
 * over BEP-20 destroys the funds and no amount of support can undo it, so the
 * network is stated three times in three registers: as a chip on the card, in
 * the address label, and as a warning. Repetition is the right call when the
 * cost of missing it is total.
 *
 * ## The screen watches for the deposit
 *
 * The thing this screen previously got wrong was going quiet at the exact moment
 * the user acts. They copy the address, switch to Binance, send, and come back —
 * to the same static QR, with no acknowledgement that anything happened. So it
 * polls while it is open: "Waiting for your deposit" becomes "Deposit detected"
 * and then a live confirmation count, on this screen, without the user having to
 * go looking. That is the difference between an address dispenser and something
 * that feels like it is paying attention.
 *
 * ## Why the QR carries the coin's logo
 *
 * Not decoration. The single most dangerous mistake here is scanning the right
 * QR for the wrong asset, and a mark in the centre is checkable at a glance in
 * the half-second before someone hits send.
 */

import { useMemo } from 'react';
import { Share, View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from '@/design';
import {
  Button,
  COIN_IMAGE,
  CopyField,
  Screen,
  Skeleton,
  Stagger,
  Surface,
  Text,
} from '@/components/ui';
import ScreenHeader from '@/components/navigation/ScreenHeader';
import { useDepositAddress, usePendingDeposits } from '@/hooks/useExchange';
import { CHAINS_FOR_ASSET, parseAsset, parseChainFor } from '@/constants/assets';
import type { Chain } from '@/services/v2/types';

/**
 * Roughly how long a deposit takes to credit, from block time × threshold.
 *
 * "About 1 minute" is an answer; "20 confirmations" is a number the user has to
 * translate. Deliberately rounded and hedged — a precise-looking estimate that
 * slips reads as a broken promise.
 */
function estimatedWait(chain: Chain, confirmations: number): string {
  const secondsPerBlock: Record<Chain, number> = {
    bitcoin: 600,
    ethereum: 12,
    bsc: 3,
    polygon: 2,
    base: 2,
    tron: 3,
    solana: 1,
  };

  const seconds = (secondsPerBlock[chain] ?? 12) * confirmations;
  if (seconds < 90) return 'about a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

export default function DepositAddressScreen() {
  const router = useRouter();
  const { c, space, radius } = useTheme();
  const params = useLocalSearchParams<{ asset: string; chain: string }>();

  const asset = parseAsset(params.asset);
  const chain = asset ? parseChainFor(asset, params.chain) : null;

  const ready = !!asset && !!chain;
  const { data: deposit, isLoading } = useDepositAddress(asset!, chain!, ready);

  // Polls only while something is in flight — see the hook.
  const { data: pending = [] } = usePendingDeposits();

  // Only deposits for the asset on screen. A BTC deposit confirming elsewhere is
  // not news on the USDT address page.
  const inbound = useMemo(
    () => pending.find((d) => d.asset === asset && d.chain === chain),
    [pending, asset, chain],
  );

  // An asset/network pair the backend can't derive an address for must never
  // render a half-built screen — send them back to pick again.
  if (!asset) return <Redirect href="/deposit" />;
  if (!chain) return <Redirect href={{ pathname: '/deposit/[asset]', params: { asset } }} />;

  const meta = (CHAINS_FOR_ASSET[asset] ?? []).find((x) => x.chain === chain);
  const networkLabel = deposit?.network ?? meta?.network ?? chain;

  const share = () => {
    if (!deposit) return;
    Share.share({
      message: deposit.address,
      title: `My ${asset} address (${networkLabel})`,
    }).catch(() => {});
  };

  return (
    <Screen edges={['top']}>
      <ScreenHeader title={`Receive ${asset}`} onBack={() => router.back()} />

      {isLoading || !deposit ? (
        <Surface level={1} style={{ marginTop: space.base, alignItems: 'center', gap: space.roomy }}>
          <Skeleton width={110} height={26} radius={999} />
          <Skeleton width={196} height={196} radius={radius.tile} />
          <Skeleton width="100%" height={56} radius={radius.field} />
        </Surface>
      ) : (
        <>
          {/* One card: network, code, address, actions. Previously these were
              four separate grey boxes, which read as four unrelated facts
              rather than one thing you scan and send to. */}
          <Stagger index={0}>
            <Surface
              level={1}
              style={{ marginTop: space.base, alignItems: 'center', gap: space.comfy }}
            >
              {/* The network, as the first thing on the card. */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: c.warningDim,
                  borderRadius: radius.chip,
                  paddingVertical: 6,
                  paddingHorizontal: space.base,
                }}
              >
                <Ionicons name="git-network-outline" size={13} color={c.warning} />
                <Text variant="eyebrow" color="warning">
                  {networkLabel} only
                </Text>
              </View>

              {/* Permanent white plate: inverting a QR for dark mode breaks
                  scanners that expect dark-on-light. */}
              <View style={{ backgroundColor: '#FFFFFF', padding: 16, borderRadius: radius.tile }}>
                <QRCode
                  value={deposit.address}
                  size={196}
                  backgroundColor="#FFFFFF"
                  color="#000000"
                  logo={COIN_IMAGE[asset]}
                  logoSize={44}
                  logoBackgroundColor="#FFFFFF"
                  logoBorderRadius={22}
                  logoMargin={4}
                  // Highest correction level, because the logo punches a hole in
                  // the code and a lower level would stop some scanners reading it.
                  ecl="H"
                />
              </View>

              <View style={{ width: '100%' }}>
                <CopyField value={deposit.address} groupSize={4} />
              </View>

              <View style={{ flexDirection: 'row', gap: space.snug, width: '100%' }}>
                <Button
                  title="Share"
                  variant="secondary"
                  icon="share-outline"
                  onPress={share}
                  style={{ flex: 1 }}
                />
                <Button
                  title="Done"
                  onPress={() => router.dismissTo('/(tabs)/(main)')}
                  style={{ flex: 1 }}
                />
              </View>
            </Surface>
          </Stagger>

          {/* Live status. The reason to stay on this screen after sending. */}
          <Stagger index={1}>
            <View style={{ marginTop: space.base }}>
              {inbound ? (
                <IncomingDeposit
                  asset={asset}
                  amount={inbound.amount}
                  confirmations={inbound.confirmations}
                  minConfirmations={inbound.minConfirmations}
                />
              ) : (
                <WaitingForDeposit
                  wait={estimatedWait(chain, deposit.minConfirmations)}
                />
              )}
            </View>
          </Stagger>

          <Stagger index={2}>
            <Surface
              level={1}
              accentEdge={c.warning}
              style={{ marginTop: space.base, flexDirection: 'row', gap: space.base }}
            >
              <Ionicons name="warning-outline" size={19} color={c.warning} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text variant="subheading" color="warning">
                  Send {asset} on {networkLabel} only
                </Text>
                <Text variant="bodySmall" color="secondaryText">
                  {asset} exists on other networks too. Sending from one of those to this address
                  loses the funds permanently — it cannot be reversed or recovered.
                </Text>
              </View>
            </Surface>
          </Stagger>

          <Stagger index={3}>
            <Surface
              level={1}
              padding={0}
              style={{ marginTop: space.base, paddingHorizontal: space.comfy }}
            >
              <Fact label="Minimum deposit" value={`${deposit.minimumDeposit} ${asset}`} />
              <Fact
                label="Arrives in"
                value={estimatedWait(chain, deposit.minConfirmations)}
              />
              <Fact
                label="Confirmations"
                value={`${deposit.minConfirmations}`}
              />
              <Fact label="Deposit fee" value="Free" last />
            </Surface>
          </Stagger>

          <Stagger index={4}>
            <Text
              variant="caption"
              color="tertiaryText"
              align="center"
              style={{ marginTop: space.comfy }}
            >
              This address is permanently yours. Reuse it for every {asset} deposit on{' '}
              {networkLabel}.
            </Text>
          </Stagger>
        </>
      )}
    </Screen>
  );
}

/**
 * The idle state.
 *
 * Deliberately not a spinner. Nothing is loading — we are waiting on the user
 * and then on a chain, and a spinner would imply the app is stuck.
 */
function WaitingForDeposit({ wait }: { wait: string }) {
  const { c, space } = useTheme();

  return (
    <Surface level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          backgroundColor: c.surfaceElevated,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name="scan-outline" size={17} color={c.tertiaryText} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="subheading">Waiting for your deposit</Text>
        <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
          Send to the address above and it appears here in {wait}.
        </Text>
      </View>
    </Surface>
  );
}

/**
 * A deposit is on the way.
 *
 * This is the payoff for staying on the screen: the user sees their own transfer
 * land and progress, rather than refreshing a balance that has not moved yet.
 */
function IncomingDeposit({
  asset,
  amount,
  confirmations,
  minConfirmations,
}: {
  asset: string;
  amount: string;
  confirmations: number;
  minConfirmations: number;
}) {
  const { c, space, radius } = useTheme();
  const ratio = Math.min(1, confirmations / Math.max(1, minConfirmations));
  const remaining = Math.max(0, minConfirmations - confirmations);
  const done = remaining === 0;

  return (
    <Surface
      level={1}
      accentEdge={done ? c.positive : c.warning}
      style={{ gap: space.base }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: done ? c.positiveDim : c.warningDim,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={done ? 'checkmark' : 'arrow-down'}
            size={17}
            color={done ? c.positive : c.warning}
          />
        </View>

        <View style={{ flex: 1 }}>
          <Text variant="subheading">
            {done ? 'Crediting your balance' : 'Deposit detected'}
          </Text>
          <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
            {done
              ? 'Done in a moment.'
              : `${remaining} more confirmation${remaining === 1 ? '' : 's'} to go`}
          </Text>
        </View>

        <Text variant="amount">
          {amount} {asset}
        </Text>
      </View>

      <View
        accessibilityRole="progressbar"
        accessibilityLabel={`${confirmations} of ${minConfirmations} confirmations`}
        style={{
          height: 3,
          borderRadius: radius.chip,
          backgroundColor: c.surfaceElevated,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: '100%',
            borderRadius: radius.chip,
            backgroundColor: done ? c.positive : c.warning,
          }}
        />
      </View>
    </Surface>
  );
}

/** A label/value line in the facts block. */
function Fact({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  const { c, space } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: space.base,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <Text variant="bodySmall" color="secondaryText">
        {label}
      </Text>
      <Text variant="amountSmall">{value}</Text>
    </View>
  );
}
