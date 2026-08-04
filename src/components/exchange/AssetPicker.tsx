/**
 * AssetPicker.
 *
 * A wrapping grid of tiles rather than a single row divided by screen width.
 * The previous implementation computed `(screenWidth - 40 - gaps) / 5` for five
 * coins, giving roughly 60px per target — below the 44pt minimum once inner
 * padding is subtracted, on the control that selects which asset you're about to
 * move. Tiles here hold a fixed comfortable size and wrap to a second line
 * instead of shrinking, so adding a seventh asset degrades the layout rather
 * than the touch target.
 *
 * Selection is shown by the asset's own brand colour, not by the lime. A picked
 * coin is state, not an action, and tinting it lime would put it in the same
 * visual class as the confirm button below it.
 */

import { View } from 'react-native';
import { useTheme } from '@/design';
import { ASSET_META, AssetGlyph, Surface, Text } from '@/components/ui';
import type { Asset } from '@/services/v2/types';

export interface AssetPickerProps {
  assets: Asset[];
  value: Asset | null;
  onChange: (asset: Asset) => void;
  /** Balances keyed by asset, shown under the ticker where present. */
  balances?: Partial<Record<Asset, string>>;
}

export function AssetPicker({ assets, value, onChange, balances }: AssetPickerProps) {
  const { c, space } = useTheme();

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.snug }}>
      {assets.map((asset) => {
        const selected = value === asset;
        const brand = ASSET_META[asset]?.color ?? c.primaryText;
        const balance = balances?.[asset];

        return (
          <Surface
            key={asset}
            level={selected ? 2 : 1}
            radiusToken="tile"
            padding={space.base}
            onPress={() => onChange(asset)}
            style={{
              minWidth: 96,
              flexGrow: 1,
              flexBasis: '30%',
              alignItems: 'center',
              gap: 3,
              borderWidth: 1,
              borderColor: selected ? brand : 'transparent',
            }}
            accessibilityLabel={`${asset}${balance ? `, balance ${balance}` : ''}`}
          >
            <AssetGlyph asset={asset} size={30} />
            <Text variant="label" color={selected ? 'primaryText' : 'secondaryText'}>
              {asset}
            </Text>
            {balance ? (
              <Text variant="caption" color="tertiaryText">
                {balance}
              </Text>
            ) : null}
          </Surface>
        );
      })}
    </View>
  );
}

export default AssetPicker;
