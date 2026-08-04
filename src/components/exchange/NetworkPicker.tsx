/**
 * NetworkPicker.
 *
 * Full-width rows, one per network, each stating its confirmation count. Rows
 * rather than chips because this is the choice that loses money when it's wrong,
 * and a row has space to say what the network is actually called — users think
 * in "TRC-20" and "BEP-20", the labels their sending wallet shows them, so those
 * strings lead and the friendly chain name follows.
 */

import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Surface, Text } from '@/components/ui';
import type { Chain, ChainMeta } from '@/services/v2/types';

export interface NetworkPickerProps {
  options: ChainMeta[];
  value: Chain | null;
  onChange: (chain: Chain) => void;
}

export function NetworkPicker({ options, value, onChange }: NetworkPickerProps) {
  const { c, radius, space } = useTheme();

  return (
    <View style={{ gap: space.snug }}>
      {options.map((option) => {
        const selected = value === option.chain;
        return (
          <Surface
            key={option.chain}
            level={selected ? 2 : 1}
            radiusToken="tile"
            padding={space.comfy}
            onPress={() => onChange(option.chain)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.base,
              borderWidth: 1,
              borderColor: selected ? c.primaryAccent : 'transparent',
            }}
            accessibilityLabel={`${option.network}, ${option.minConfirmations} confirmations`}
          >
            <View style={{ flex: 1 }}>
              <Text variant="subheading">{option.network}</Text>
              <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
                {option.label} · {option.minConfirmations} confirmation
                {option.minConfirmations === 1 ? '' : 's'}
              </Text>
            </View>

            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: radius.chip,
                borderWidth: selected ? 0 : 1.5,
                borderColor: c.borderLight,
                backgroundColor: selected ? c.primaryAccent : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {selected ? (
                <Ionicons name="checkmark" size={13} color={c.buttonTextOnAccent} />
              ) : null}
            </View>
          </Surface>
        );
      })}
    </View>
  );
}

export default NetworkPicker;
