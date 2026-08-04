/**
 * NetworkSheet — network choice for multi chain assets.
 *
 * Shared by Convert and Sell crypto. Danger warning first, then a flat list.
 * Nothing is preselected.
 */

import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { AssetGlyph, Sheet, Text } from '@/components/ui';
import type { Asset, Chain, ChainMeta } from '@/services/v2/types';


export interface NetworkSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Null while the sheet animates out, so the panel keeps its content. */
  asset: Asset | null;
  options: ChainMeta[];
  onSelect: (chain: Chain) => void;
}

export function NetworkSheet({ visible, onClose, asset, options, onSelect }: NetworkSheetProps) {
  const { c, radius, space, minTouch } = useTheme();

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={asset ? `Choose ${asset} network` : 'Choose network'}
      subtitle="Use the same network as your sending wallet."
    >
      <View
        style={{
          flexDirection: 'row',
          gap: space.base,
          marginBottom: space.roomy,
          padding: space.comfy,
          borderRadius: radius.card,
          backgroundColor: c.dangerDim,
          borderWidth: 1,
          borderColor: c.danger,
        }}
      >
        <Ionicons name="alert-circle" size={18} color={c.danger} style={{ marginTop: 2 }} />
        <Text variant="bodySmall" color="secondaryText" style={{ flex: 1 }}>
          {asset ?? 'This coin'} has a different address on each network. Funds sent on the wrong
          network are lost permanently.
        </Text>
      </View>

      <View
        style={{
          borderRadius: radius.card,
          borderWidth: 1,
          borderColor: c.hairline,
          backgroundColor: c.surface,
          overflow: 'hidden',
        }}
      >
        {options.map((option, i) => {
          const last = i === options.length - 1;
          return (
            <Pressable
              key={option.chain}
              accessibilityRole="button"
              accessibilityLabel={`${option.network}, ${option.label}`}
              onPress={() => onSelect(option.chain)}
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
              {asset ? <AssetGlyph asset={asset} size={36} /> : null}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="subheading">{option.network}</Text>
                <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
                  {option.label} · {option.minConfirmations} confirmation
                  {option.minConfirmations === 1 ? '' : 's'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={c.quaternaryText} />
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

export default NetworkSheet;
