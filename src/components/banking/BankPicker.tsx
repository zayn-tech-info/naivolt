/**
 * BankPicker — choose an institution.
 *
 * A full-screen modal with search focused on open, because with 30+ banks
 * scrolling is the slow path and everyone knows their bank's name. Search
 * matches on name and code, and strips common noise words so "gt" finds GTBank
 * and "first" finds First Bank without an exact prefix.
 *
 * Fintechs are grouped and shown first when the list is unfiltered. In Nigeria a
 * large share of transfers go to OPay, PalmPay, Kuda or Moniepoint, and burying
 * those under an alphabetical run of commercial banks puts the most-used
 * destinations at the bottom.
 */

import { useCallback, useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { EmptyState, Input, Skeleton, Text } from '@/components/ui';
import { useBanks } from '@/hooks/useExchange';
import type { Bank } from '@/services/v2/types';

export interface BankPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (bank: Bank) => void;
  selectedCode?: string | null;
}

/** Deterministic tint per institution, so a bank looks the same every time. */
function bankTint(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${hash}, 55%, 52%)`;
}

function initials(name: string): string {
  const words = name.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function BankPicker({ visible, onClose, onSelect, selectedCode }: BankPickerProps) {
  const { c, space, radius } = useTheme();
  const [query, setQuery] = useState('');
  const { data: banks = [], isLoading } = useBanks();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Unfiltered: fintechs first, then everything else, each alphabetical.
      const fintechs = banks.filter((b) => b.kind === 'fintech');
      const rest = banks.filter((b) => b.kind !== 'fintech');
      const byName = (a: Bank, b: Bank) => a.name.localeCompare(b.name);
      return [...fintechs.sort(byName), ...rest.sort(byName)];
    }
    return banks.filter(
      (b) => b.name.toLowerCase().includes(q) || b.code.toLowerCase().includes(q)
    );
  }, [banks, query]);

  const handleSelect = useCallback(
    (bank: Bank) => {
      setQuery('');
      onSelect(bank);
      onClose();
    },
    [onSelect, onClose]
  );

  const handleClose = useCallback(() => {
    setQuery('');
    onClose();
  }, [onClose]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.primaryBackground }} edges={['top']}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.base,
            paddingHorizontal: space.roomy,
            height: 52,
          }}
        >
          <Text variant="heading" style={{ flex: 1 }}>
            Select bank
          </Text>
          <Pressable
            onPress={handleClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: c.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="close" size={18} color={c.primaryText} />
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: space.roomy }}>
          <Input
            value={query}
            onChangeText={setQuery}
            placeholder="Search banks"
            icon="search-outline"
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            containerStyle={{ marginBottom: space.snug }}
          />
        </View>

        {isLoading ? (
          <View style={{ paddingHorizontal: space.roomy, gap: space.comfy, marginTop: space.snug }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
                <Skeleton width={38} height={38} radius={19} />
                <Skeleton width={160} height={14} />
              </View>
            ))}
          </View>
        ) : (
          <FlatList
            data={results}
            keyExtractor={(item) => `${item.code}-${item.name}`}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: space.roomy, paddingBottom: space.major }}
            ListEmptyComponent={
              <View style={{ marginTop: space.major }}>
                <EmptyState
                  icon="search-outline"
                  title="No match"
                  body={`Nothing found for “${query.trim()}”. Try the bank's full name.`}
                  inset
                />
              </View>
            }
            renderItem={({ item, index }) => {
              const selected = item.code === selectedCode;
              const tint = bankTint(item.name);
              return (
                <Pressable
                  onPress={() => handleSelect(item)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.base,
                    paddingVertical: space.base,
                    ...(index === results.length - 1
                      ? null
                      : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
                  }}
                >
                  <View
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 19,
                      backgroundColor: `${tint}22`,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text variant="label" color={tint} style={{ fontSize: 12 }}>
                      {initials(item.name)}
                    </Text>
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text variant="subheading" numberOfLines={1}>
                      {item.name}
                    </Text>
                    {item.kind === 'fintech' ? (
                      <Text variant="caption" color="tertiaryText" style={{ marginTop: 1 }}>
                        Fintech
                      </Text>
                    ) : null}
                  </View>

                  {selected ? (
                    <Ionicons name="checkmark" size={18} color={c.primaryAccent} />
                  ) : null}
                </Pressable>
              );
            }}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

export default BankPicker;
export { bankTint, initials as bankInitials };
