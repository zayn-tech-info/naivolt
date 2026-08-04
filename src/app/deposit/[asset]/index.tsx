/**
 * Sell — step 2: choose the network, as a page.
 *
 * In the normal flow this choice is a sheet raised over the coin list (see
 * components/exchange/NetworkSheet). This page is the deep-link entry point:
 * `/deposit/USDT` arriving from a link or a restored session has no coin list
 * behind it to raise a sheet over, so the choice needs somewhere to live.
 *
 * Same rule as the sheet — nothing is pre-selected. A highlighted default is a
 * network the user did not choose, and "I just tapped continue" is exactly how
 * that mistake gets made. Every row is an explicit tap that navigates.
 */

import { useCallback } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Group, ListRow, Screen, Section, Surface, Text } from '@/components/ui';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { CHAINS_FOR_ASSET, parseAsset } from '@/constants/assets';
import { useTheme } from '@/design';

export default function DepositNetworkScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const params = useLocalSearchParams<{ asset: string }>();

  const asset = parseAsset(params.asset);
  const chains = asset ? (CHAINS_FOR_ASSET[asset] ?? []) : [];

  const choose = useCallback(
    (chain: string) => {
      if (!asset) return;
      router.push({ pathname: '/deposit/[asset]/[chain]', params: { asset, chain } });
    },
    [asset, router],
  );

  // A URL naming an asset we don't support is a dead end, not a blank screen.
  if (!asset || chains.length === 0) return <Redirect href="/deposit" />;

  // Deep-linked to an asset with exactly one network: replace rather than push,
  // so Back returns to the asset list instead of a screen with one option.
  if (chains.length === 1) {
    return (
      <Redirect
        href={{ pathname: '/deposit/[asset]/[chain]', params: { asset, chain: chains[0].chain } }}
      />
    );
  }

  return (
    <Screen edges={['top']}>
      <ScreenHeader title={`Sell ${asset}`} onBack={() => router.back()} />

      <Surface
        level={1}
        accentEdge={c.warning}
        style={{ marginTop: space.base, flexDirection: 'row', gap: space.base }}
      >
        <Ionicons name="warning-outline" size={19} color={c.warning} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="subheading" color="warning">
            Pick the network you&apos;ll send on
          </Text>
          <Text variant="bodySmall" color="secondaryText">
            {asset} has a different address on each network. Choose the one your sending wallet
            uses — funds sent on any other network are lost permanently.
          </Text>
        </View>
      </Surface>

      <Section title="Network">
        <Group>
          {chains.map((option, i) => (
            <ListRow
              key={option.chain}
              title={option.network}
              subtitle={`${option.label} · ${option.minConfirmations} confirmation${
                option.minConfirmations === 1 ? '' : 's'
              }`}
              onPress={() => choose(option.chain)}
              last={i === chains.length - 1}
            />
          ))}
        </Group>
      </Section>
    </Screen>
  );
}
