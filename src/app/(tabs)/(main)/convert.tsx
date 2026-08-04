/**
 * Rate — live board + sell calculator.
 *
 * Two in-screen tabs: Rates (supported coins and receive rates) and Calculator
 * (the existing convert calculator into deposit address).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  ASSET_META,
  AssetGlyph,
  Button,
  Money,
  Screen,
  SegmentedControl,
  Skeleton,
  Stagger,
  Text,
  TopLevelHeader,
} from '@/components/ui';
import {
  ConvertCalculator,
  deriveCrypto,
  deriveNgn,
  type CalcSource,
} from '@/components/exchange/ConvertCalculator';
import { AssetSheet } from '@/components/exchange/AssetSheet';
import { NetworkSheet } from '@/components/exchange/NetworkSheet';
import { useRates } from '@/hooks/useExchange';
import { CHAINS_FOR_ASSET } from '@/constants/assets';
import type { Asset, Chain, ChainMeta } from '@/services/v2/types';

type RateTab = 'rates' | 'calculator';

const RATES_REFRESH_SEC = 30;

const TABS: { value: RateTab; label: string }[] = [
  { value: 'rates', label: 'Rates' },
  { value: 'calculator', label: 'Calculator' },
];

function pickDefaultAsset(assets: Asset[]): Asset | null {
  if (assets.includes('USDT')) return 'USDT';
  return assets[0] ?? null;
}

function autoChain(asset: Asset): ChainMeta | null {
  const chains = CHAINS_FOR_ASSET[asset] ?? [];
  return chains.length === 1 ? chains[0] : null;
}

function useRefreshCountdown(dataUpdatedAt: number) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!dataUpdatedAt) return RATES_REFRESH_SEC;
  const elapsedSec = Math.floor((now - dataUpdatedAt) / 1000);
  return Math.max(0, RATES_REFRESH_SEC - elapsedSec);
}

export default function RateScreen() {
  const router = useRouter();
  const { c, radius, space, minTouch } = useTheme();
  const [tab, setTab] = useState<RateTab>('rates');
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [network, setNetwork] = useState<ChainMeta | null>(null);
  const [cryptoAmount, setCryptoAmount] = useState('');
  const [ngnAmount, setNgnAmount] = useState('');
  const [source, setSource] = useState<CalcSource>('crypto');
  const [cryptoFirst, setCryptoFirst] = useState(true);
  const [assetSheetOpen, setAssetSheetOpen] = useState(false);
  const [networkSheetOpen, setNetworkSheetOpen] = useState(false);
  const [networkForConvert, setNetworkForConvert] = useState(false);

  const rates = useRates();
  const secondsLeft = useRefreshCountdown(rates.dataUpdatedAt);

  const board = rates.data?.assets ?? [];
  const boardAssets = useMemo(() => board.map((row) => row.asset), [board]);
  const ngnPerUsd = rates.data ? Number(rates.data.ngnPerUsd) : null;

  useEffect(() => {
    if (selected && boardAssets.includes(selected)) return;
    const next = pickDefaultAsset(boardAssets);
    if (!next) return;
    setSelected(next);
    setNetwork(autoChain(next));
  }, [boardAssets, selected]);

  const selectedRow = board.find((row) => row.asset === selected) ?? null;
  const selectedRate = selectedRow ? Number(selectedRow.rate) : null;
  const rateOk = selectedRate != null && Number.isFinite(selectedRate) && selectedRate > 0;

  const recomputeFromSource = useCallback(
    (nextAsset: Asset, nextSource: CalcSource, crypto: string, ngn: string) => {
      const row = board.find((r) => r.asset === nextAsset);
      const rate = row ? Number(row.rate) : null;
      if (nextSource === 'crypto') {
        setCryptoAmount(crypto);
        setNgnAmount(deriveNgn(crypto, rate));
      } else {
        setNgnAmount(ngn);
        setCryptoAmount(deriveCrypto(ngn, rate, nextAsset));
      }
    },
    [board]
  );

  const applyAsset = useCallback(
    (asset: Asset) => {
      setSelected(asset);
      recomputeFromSource(asset, source, cryptoAmount, ngnAmount);
      const chains = CHAINS_FOR_ASSET[asset] ?? [];
      setAssetSheetOpen(false);

      if (chains.length === 1) {
        setNetwork(chains[0]);
        setNetworkSheetOpen(false);
        return;
      }

      if (chains.length > 1) {
        setNetwork(null);
        setNetworkForConvert(false);
        setTimeout(() => setNetworkSheetOpen(true), 220);
        return;
      }

      setNetwork(null);
    },
    [cryptoAmount, ngnAmount, recomputeFromSource, source]
  );

  const onCryptoChange = useCallback(
    (value: string) => {
      setSource('crypto');
      setCryptoAmount(value);
      setNgnAmount(deriveNgn(value, selectedRate));
    },
    [selectedRate]
  );

  const onNgnChange = useCallback(
    (value: string) => {
      setSource('ngn');
      setNgnAmount(value);
      if (selected) setCryptoAmount(deriveCrypto(value, selectedRate, selected));
    },
    [selected, selectedRate]
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await rates.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [rates]);

  const openAddress = useCallback(
    (asset: Asset, chain: Chain) => {
      const trimmed = cryptoAmount.trim();
      setNetworkSheetOpen(false);
      setNetworkForConvert(false);
      router.push({
        pathname: '/deposit/[asset]/[chain]',
        params: {
          asset,
          chain,
          ...(trimmed !== '' && Number(trimmed) > 0 ? { amount: trimmed } : null),
        },
      });
    },
    [cryptoAmount, router]
  );

  const onConvert = useCallback(() => {
    if (!selected) return;
    const chains = CHAINS_FOR_ASSET[selected] ?? [];
    if (chains.length === 0) return;

    if (network) {
      openAddress(selected, network.chain);
      return;
    }

    if (chains.length === 1) {
      openAddress(selected, chains[0].chain);
      return;
    }

    setNetworkForConvert(true);
    setNetworkSheetOpen(true);
  }, [network, openAddress, selected]);

  const onPickChain = useCallback(
    (chain: Chain) => {
      if (!selected) return;
      const meta = (CHAINS_FOR_ASSET[selected] ?? []).find((x) => x.chain === chain) ?? null;
      setNetwork(meta);
      setNetworkSheetOpen(false);

      if (networkForConvert) {
        openAddress(selected, chain);
      }
    },
    [networkForConvert, openAddress, selected]
  );

  const openNetworkPicker = useCallback(() => {
    if (!selected) return;
    const chains = CHAINS_FOR_ASSET[selected] ?? [];
    if (chains.length <= 1) return;
    setNetworkForConvert(false);
    setNetworkSheetOpen(true);
  }, [selected]);

  const multiChain = selected ? (CHAINS_FOR_ASSET[selected] ?? []).length > 1 : false;

  return (
    <Screen tabBarClearance refreshing={refreshing} onRefresh={onRefresh}>
      <TopLevelHeader title="Rate" supportingText="Live prices and a sell calculator" />

      <View style={{ marginTop: space.comfy }}>
        <SegmentedControl segments={TABS} value={tab} onChange={setTab} />
      </View>

      {tab === 'rates' ? (
        <RatesPanel
          loading={rates.isLoading && board.length === 0}
          error={rates.isError && !rates.data}
          board={board}
          ngnPerUsd={ngnPerUsd}
          secondsLeft={secondsLeft}
          onRetry={() => void onRefresh()}
        />
      ) : (
        <CalculatorPanel
          selected={selected}
          network={network}
          rateOk={rateOk}
          selectedRate={selectedRate}
          cryptoAmount={cryptoAmount}
          ngnAmount={ngnAmount}
          cryptoFirst={cryptoFirst}
          loading={rates.isLoading && !selected}
          error={rates.isError && !rates.data}
          multiChain={multiChain}
          onCryptoChange={onCryptoChange}
          onNgnChange={onNgnChange}
          onPressAsset={() => setAssetSheetOpen(true)}
          onPressNetwork={multiChain ? openNetworkPicker : undefined}
          onSwap={() => setCryptoFirst((v) => !v)}
          onConvert={onConvert}
          onRetry={() => void onRefresh()}
          convertDisabled={!selected || (CHAINS_FOR_ASSET[selected] ?? []).length === 0}
        />
      )}

      <AssetSheet
        visible={assetSheetOpen}
        onClose={() => setAssetSheetOpen(false)}
        assets={
          boardAssets.length > 0
            ? boardAssets
            : (['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'SOL'] as Asset[])
        }
        selected={selected}
        onSelect={applyAsset}
      />

      <NetworkSheet
        visible={networkSheetOpen}
        onClose={() => {
          setNetworkSheetOpen(false);
          setNetworkForConvert(false);
        }}
        asset={selected}
        options={selected ? (CHAINS_FOR_ASSET[selected] ?? []) : []}
        onSelect={onPickChain}
      />
    </Screen>
  );
}

function RatesPanel({
  loading,
  error,
  board,
  ngnPerUsd,
  secondsLeft,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  board: { asset: Asset; usdPrice: string; rate: string; changePct24h: number | null }[];
  ngnPerUsd: number | null;
  secondsLeft: number;
  onRetry: () => void;
}) {
  const { c, radius, space, minTouch } = useTheme();

  return (
    <View style={{ marginTop: space.comfy, gap: space.comfy }}>
      <Stagger index={0}>
        <View
          style={{
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: c.hairline,
            backgroundColor: c.surface,
            padding: space.comfy,
            gap: space.snug,
          }}
        >
          <Text variant="eyebrow" color="tertiaryText">
            Rate refreshes in
          </Text>
          {loading ? (
            <Skeleton width={80} height={28} radius={radius.control} />
          ) : error ? (
            <View style={{ gap: space.snug }}>
              <Text variant="body" color="secondaryText">
                Rates could not load.
              </Text>
              <Button title="Try again" variant="secondary" size="sm" onPress={onRetry} />
            </View>
          ) : (
            <>
              <Text variant="figure">{formatCountdown(secondsLeft)}</Text>
              {ngnPerUsd != null ? (
                <Text variant="caption" color="tertiaryText">
                  Headline receive rate · ₦{Math.round(ngnPerUsd).toLocaleString('en-NG')} per $1
                </Text>
              ) : null}
            </>
          )}
        </View>
      </Stagger>

      <Stagger index={1}>
        {loading ? (
          <View
            style={{
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: c.hairline,
              backgroundColor: c.surface,
              padding: space.comfy,
              gap: space.comfy,
            }}
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.comfy }}>
                <Skeleton width={36} height={36} radius={18} />
                <View style={{ flex: 1, gap: space.tight }}>
                  <Skeleton width={70} height={13} />
                  <Skeleton width={100} height={11} />
                </View>
                <Skeleton width={90} height={16} />
              </View>
            ))}
          </View>
        ) : board.length === 0 ? (
          <View
            style={{
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: c.hairline,
              backgroundColor: c.surface,
              padding: space.comfy,
              alignItems: 'center',
              gap: space.snug,
            }}
          >
            <Ionicons name="cloud-offline-outline" size={22} color={c.quaternaryText} />
            <Text variant="bodySmall" color="tertiaryText" align="center">
              Rates are unavailable right now. Pull down to try again.
            </Text>
          </View>
        ) : (
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
            {board.map((row, i) => {
              const change = row.changePct24h;
              const rose = (change ?? 0) >= 0;
              const last = i === board.length - 1;
              return (
                <View
                  key={row.asset}
                  style={{
                    minHeight: minTouch + 4,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.comfy,
                    paddingVertical: space.comfy,
                    ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
                  }}
                >
                  <AssetGlyph asset={row.asset} size={36} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="subheading">{row.asset}</Text>
                    <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
                      {ASSET_META[row.asset]?.name ?? row.asset}
                    </Text>
                  </View>
                      <View style={{ alignItems: 'flex-end' }}>
                    <Money
                      value={Number(row.rate)}
                      currency="NGN"
                      whole
                      live
                    />
                    <View
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}
                    >
                      {change != null ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                          <Ionicons
                            name={rose ? 'caret-up' : 'caret-down'}
                            size={9}
                            color={rose ? c.positive : c.negative}
                          />
                          <Text variant="ticker" color={rose ? 'positive' : 'negative'}>
                            {Math.abs(change).toFixed(2)}%
                          </Text>
                        </View>
                      ) : null}
                      <Money
                        value={Number(row.usdPrice)}
                        currency="USD"
                        variant="amountSmall"
                        color="tertiaryText"
                        maxFractionDigits={Number(row.usdPrice) < 10 ? 4 : 2}
                      />
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </Stagger>

      <Stagger index={2}>
        <View style={{ flexDirection: 'row', gap: space.snug, paddingHorizontal: space.tight }}>
          <Ionicons name="information-circle-outline" size={14} color={c.tertiaryText} />
          <Text variant="caption" color="tertiaryText" style={{ flex: 1 }}>
            Prices update every 30 seconds. Every figure is the receive rate — nothing is deducted
            afterwards.
          </Text>
        </View>
      </Stagger>
    </View>
  );
}

function CalculatorPanel({
  selected,
  network,
  rateOk,
  selectedRate,
  cryptoAmount,
  ngnAmount,
  cryptoFirst,
  loading,
  error,
  multiChain,
  onCryptoChange,
  onNgnChange,
  onPressAsset,
  onPressNetwork,
  onSwap,
  onConvert,
  onRetry,
  convertDisabled,
}: {
  selected: Asset | null;
  network: ChainMeta | null;
  rateOk: boolean;
  selectedRate: number | null;
  cryptoAmount: string;
  ngnAmount: string;
  cryptoFirst: boolean;
  loading: boolean;
  error: boolean;
  multiChain: boolean;
  onCryptoChange: (v: string) => void;
  onNgnChange: (v: string) => void;
  onPressAsset: () => void;
  onPressNetwork?: () => void;
  onSwap: () => void;
  onConvert: () => void;
  onRetry: () => void;
  convertDisabled: boolean;
}) {
  const { c, radius, space } = useTheme();

  return (
    <View style={{ marginTop: space.comfy, gap: space.comfy }}>
      <Stagger index={0}>
        {selected ? (
          <ConvertCalculator
            asset={selected}
            network={network}
            rate={rateOk ? selectedRate : null}
            cryptoAmount={cryptoAmount}
            ngnAmount={ngnAmount}
            cryptoFirst={cryptoFirst}
            onCryptoChange={onCryptoChange}
            onNgnChange={onNgnChange}
            onPressAsset={onPressAsset}
            onPressNetwork={onPressNetwork}
            onSwap={onSwap}
          />
        ) : loading ? (
          <View
            style={{
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: c.hairline,
              backgroundColor: c.surface,
              padding: space.comfy,
              gap: space.base,
            }}
          >
            <Skeleton width={120} height={16} />
            <Skeleton width="100%" height={52} radius={radius.field} />
            <Skeleton width="100%" height={52} radius={radius.field} />
          </View>
        ) : error ? (
          <View
            style={{
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: c.hairline,
              backgroundColor: c.surface,
              padding: space.comfy,
              gap: space.snug,
              alignItems: 'center',
            }}
          >
            <Ionicons name="cloud-offline-outline" size={22} color={c.quaternaryText} />
            <Text variant="bodySmall" color="tertiaryText" align="center">
              Rates could not load. Pull down to try again.
            </Text>
            <Button title="Try again" variant="secondary" size="sm" onPress={onRetry} />
          </View>
        ) : (
          <View
            style={{
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: c.hairline,
              backgroundColor: c.surface,
              padding: space.comfy,
              alignItems: 'center',
            }}
          >
            <Text variant="bodySmall" color="tertiaryText" align="center">
              Rates are unavailable right now. Pull down to try again.
            </Text>
          </View>
        )}
      </Stagger>

      <Stagger index={1}>
        <Button title="Convert" onPress={onConvert} disabled={convertDisabled} fullWidth />
      </Stagger>

      <Stagger index={2}>
        <View style={{ flexDirection: 'row', gap: space.snug, paddingHorizontal: space.tight }}>
          <Ionicons name="information-circle-outline" size={14} color={c.tertiaryText} />
          <Text variant="caption" color="tertiaryText" style={{ flex: 1 }}>
            Enter an amount, pick a coin, then Convert to get a deposit address. The rate under
            receive is what you get per coin.
          </Text>
        </View>
      </Stagger>
    </View>
  );
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
