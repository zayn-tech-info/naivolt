/**
 * ListRow — the transaction/asset row.
 *
 * Rows sit on shared grouped surfaces with hairline separators instead of each
 * one being its own bordered card with a 10px gap. Grouping is what makes a
 * list read as a list; a stack of individually-boxed cards reads as unrelated
 * items and wastes vertical space.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Surface } from './Surface';
import { Text } from './Text';

export interface ListRowProps {
  /** Glyph, avatar, or icon container. */
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  /** Money, badge, or any right-aligned content. */
  trailing?: ReactNode;
  /** Secondary line under the trailing content. */
  trailingBelow?: ReactNode;
  onPress?: () => void;
  /** Show a chevron. Implied when onPress is set unless explicitly disabled. */
  chevron?: boolean;
  last?: boolean;
}

export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  trailingBelow,
  onPress,
  chevron,
  last = false,
}: ListRowProps) {
  const { c, space } = useTheme();
  const showChevron = chevron ?? (!!onPress && !trailing);

  return (
    <Surface
      level={0}
      padding={0}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.base,
        paddingVertical: space.base,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      {leading}

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="subheading" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" color="tertiaryText" numberOfLines={1} style={{ marginTop: 2 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {trailing || trailingBelow ? (
        <View style={{ alignItems: 'flex-end', gap: 5 }}>
          {trailing}
          {trailingBelow}
        </View>
      ) : null}

      {showChevron ? <Ionicons name="chevron-forward" size={17} color={c.quaternaryText} /> : null}
    </Surface>
  );
}

/**
 * Group — the container rows live in. Holds the surface and the inset so
 * separators stop short of the edge the way platform lists do.
 */
export function Group({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  const { space } = useTheme();
  return (
    <Surface level={1} padding={0} style={{ paddingHorizontal: padded ? space.comfy : 0 }}>
      {children}
    </Surface>
  );
}

export default ListRow;
