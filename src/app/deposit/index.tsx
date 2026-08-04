/**
 * Sell — step 1: choose the coin.
 *
 * Selling is a deposit. Tapping a multi-network coin raises NetworkSheet (the
 * same sheet Convert uses). Single-network coins go straight to the address.
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  ASSET_META,
  AssetGlyph,
  EmptyState,
  Input,
  Screen,
  Text,
} from '@/components/ui';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { NetworkSheet } from '@/components/exchange/NetworkSheet';
import { CHAINS_FOR_ASSET, DEPOSITABLE_ASSETS } from '@/constants/assets';
import { useTheme } from '@/design';
import type { Asset, Chain } from '@/services/v2/types';


export default function DepositAssetsScreen() {
  const router = useRouter();
  const { c, radius, space, minTouch } = useTheme();

  const [query, setQuery] = useState('');
  const [sheetAsset, setSheetAsset] = useState<Asset | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return DEPOSITABLE_ASSETS;

    return DEPOSITABLE_ASSETS.filter((asset) => {
      const name = ASSET_META[asset]?.name ?? '';
      return asset.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
    });
  }, [query]);

  const open = useCallback(
    (asset: Asset) => {
      const chains = CHAINS_FOR_ASSET[asset] ?? [];

      if (chains.length === 1) {
        router.push({
          pathname: '/deposit/[asset]/[chain]',
          params: { asset, chain: chains[0].chain },
        });
        return;
      }

      setSheetAsset(asset);
      setSheetOpen(true);
    },
    [router]
  );

  const choose = useCallback(
    (chain: Chain) => {
      if (!sheetAsset) return;
      setSheetOpen(false);
      router.push({
        pathname: '/deposit/[asset]/[chain]',
        params: { asset: sheetAsset, chain },
      });
    },
    [router, sheetAsset]
  );

  return (
    <Screen edges={['top']}>
      <ScreenHeader title="Sell crypto" onBack={() => router.back()} />

      <Input
        icon="search-outline"
        placeholder="Search asset"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
        shellRadius={radius.card}
        containerStyle={{ marginTop: space.comfy, marginBottom: 0 }}
        accessibilityLabel="Search assets"
      />

      <View style={{ marginTop: space.section, gap: space.base }}>
        <Text variant="eyebrow" color="tertiaryText">
          Available coins
        </Text>

        {results.length === 0 ? (
          <EmptyState
            icon="search-outline"
            title="No match"
            body={`We don't support “${query.trim()}” yet. Try another coin.`}
          />
        ) : (
          <View
            style={{
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: c.hairline,
              backgroundColor: c.surface,
              overflow: 'hidden',
            }}
          >
            {results.map((asset, i) => {
              const chains = CHAINS_FOR_ASSET[asset] ?? [];
              const meta = ASSET_META[asset];
              const last = i === results.length - 1;

              return (
                <Pressable
                  key={asset}
                  accessibilityRole="button"
                  accessibilityLabel={`${asset}, ${meta?.name ?? asset}`}
                  onPress={() => open(asset)}
                  style={({ pressed }) => ({
                    minHeight: minTouch + 4,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.comfy,
                    paddingHorizontal: space.comfy,
                    paddingVertical: space.base,
                    backgroundColor: pressed ? c.surfaceSunken : 'transparent',
                    ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
                  })}
                >
                  <AssetGlyph asset={asset} size={36} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="subheading" numberOfLines={1}>
                      {asset}
                    </Text>
                    <Text
                      variant="caption"
                      color="tertiaryText"
                      numberOfLines={1}
                      style={{ marginTop: 2 }}
                    >
                      {chains.length > 1
                        ? `${meta?.name ?? asset} · ${chains.length} networks`
                        : (meta?.name ?? asset)}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={c.quaternaryText} />
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      <Text
        variant="caption"
        color="tertiaryText"
        align="center"
        style={{ marginTop: space.roomy, lineHeight: 18 }}
      >
        Your deposit addresses are permanent. Reuse them for every deposit.
      </Text>

      <NetworkSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        asset={sheetAsset}
        options={sheetAsset ? (CHAINS_FOR_ASSET[sheetAsset] ?? []) : []}
        onSelect={choose}
      />
    </Screen>
  );
}
