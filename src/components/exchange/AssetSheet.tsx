/**
 * AssetSheet — searchable coin picker for Convert.
 *
 * Flat list + hairline dividers, matching Sell crypto. Multi-network coins are
 * handled by the caller (opens NetworkSheet after selection).
 */

import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { ASSET_META, AssetGlyph, Input, Sheet, Text } from '@/components/ui';
import { CHAINS_FOR_ASSET } from '@/constants/assets';
import type { Asset } from '@/services/v2/types';


export interface AssetSheetProps {
  visible: boolean;
  onClose: () => void;
  assets: Asset[];
  selected: Asset | null;
  onSelect: (asset: Asset) => void;
}

export function AssetSheet({ visible, onClose, assets, selected, onSelect }: AssetSheetProps) {
  const { c, radius, space, minTouch } = useTheme();
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return assets;
    return assets.filter((asset) => {
      const name = ASSET_META[asset]?.name ?? '';
      return asset.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
    });
  }, [assets, query]);

  return (
    <Sheet
      visible={visible}
      onClose={() => {
        setQuery('');
        onClose();
      }}
      title="Choose coin"
      subtitle="Search by ticker or name"
    >
      <Input
        value={query}
        onChangeText={setQuery}
        placeholder="Search asset"
        icon="search-outline"
        autoCapitalize="none"
        autoCorrect={false}
        shellRadius={radius.card}
        containerStyle={{ marginBottom: space.comfy }}
      />

      {results.length === 0 ? (
        <Text variant="bodySmall" color="tertiaryText" align="center">
          No coins match that search.
        </Text>
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
            const isSelected = asset === selected;
            const chains = CHAINS_FOR_ASSET[asset] ?? [];
            const meta = ASSET_META[asset];
            const last = i === results.length - 1;

            return (
              <Pressable
                key={asset}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${asset}, ${meta?.name ?? asset}`}
                onPress={() => {
                  setQuery('');
                  onSelect(asset);
                }}
                style={({ pressed }) => ({
                  minHeight: minTouch + 4,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.comfy,
                  paddingHorizontal: space.comfy,
                  paddingVertical: space.base,
                  backgroundColor: pressed
                    ? c.surfaceSunken
                    : isSelected
                      ? c.surfaceSunken
                      : 'transparent',
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
                {isSelected ? (
                  <Ionicons name="checkmark" size={18} color={c.primaryText} />
                ) : (
                  <Ionicons name="chevron-forward" size={16} color={c.quaternaryText} />
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </Sheet>
  );
}

export default AssetSheet;
