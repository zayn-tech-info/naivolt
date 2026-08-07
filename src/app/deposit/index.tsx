/**
 * Deposit — step 1: choose the asset.
 *
 * This was one screen that revealed the QR inline once an asset and network
 * were picked. Splitting it into pages is not cosmetic: on the old screen the
 * address appeared below the fold, so the user scrolled *past* the network
 * warning to reach the thing they came for, and the warning was the one piece
 * of the screen that prevents an unrecoverable mistake. A dedicated address page
 * puts the warning above the address in a viewport the user cannot skip.
 *
 * Rows with chevrons, not selection tiles. A tile that highlights when tapped
 * says "something will appear below"; a chevron says "this goes somewhere". The
 * affordance has to match what actually happens.
 */

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { ASSET_META, AssetGlyph, Group, ListRow, Screen, Section, Text } from '@/components/ui';
import ScreenHeader from '@/components/navigation/ScreenHeader';
import { CHAINS_FOR_ASSET, DEPOSITABLE_ASSETS } from '@/constants/assets';
import { useTheme } from '@/design';
import type { Asset } from '@/services/v2/types';

export default function DepositAssetsScreen() {
  const router = useRouter();
  const { space } = useTheme();

  const open = useCallback(
    (asset: Asset) => {
      const chains = CHAINS_FOR_ASSET[asset] ?? [];

      // One network means there is no choice to present. Skipping straight to
      // the address is not the same as defaulting: the user is never shown a
      // pre-selected network they didn't pick, because there was never more
      // than one.
      if (chains.length === 1) {
        router.push({
          pathname: '/deposit/[asset]/[chain]',
          params: { asset, chain: chains[0].chain },
        });
        return;
      }

      router.push({ pathname: '/deposit/[asset]', params: { asset } });
    },
    [router],
  );

  return (
    <Screen edges={['top']}>
      <ScreenHeader title="Deposit crypto" onBack={() => router.back()} />

      <Section title="Choose asset" first>
        <Group>
          {DEPOSITABLE_ASSETS.map((asset, i) => {
            const chains = CHAINS_FOR_ASSET[asset] ?? [];
            const meta = ASSET_META[asset];

            return (
              <ListRow
                key={asset}
                leading={<AssetGlyph asset={asset} size={32} />}
                title={asset}
                subtitle={
                  chains.length > 1
                    ? `${meta?.name ?? asset} · ${chains.length} networks`
                    : (meta?.name ?? asset)
                }
                onPress={() => open(asset)}
                last={i === DEPOSITABLE_ASSETS.length - 1}
              />
            );
          })}
        </Group>
      </Section>

      <Text
        variant="caption"
        color="tertiaryText"
        align="center"
        style={{ marginTop: space.comfy }}
      >
        Your deposit addresses are permanent. Reuse them for every deposit.
      </Text>
    </Screen>
  );
}
