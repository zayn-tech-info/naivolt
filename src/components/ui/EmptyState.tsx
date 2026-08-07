/**
 * EmptyState.
 *
 * An empty screen is an instruction, not a shrug. Each one names what will be
 * here and gives the single action that puts something here — so the copy is
 * "Your conversions will show up here" plus a button, never "No data".
 *
 * The icon sits in a soft accent well rather than being a large lime glyph:
 * an empty list is not an action, and shouldn't pull the eye like one.
 */

import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import Surface from './Surface';
import Text from './Text';
import Button from './Button';

export interface EmptyStateProps {
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Compact variant for inside a card. */
  inset?: boolean;
}

export function EmptyState({
  icon = 'file-tray-outline',
  title,
  body,
  actionLabel,
  onAction,
  inset = false,
}: EmptyStateProps) {
  const { c, space } = useTheme();

  return (
    <Surface
      level={inset ? 0 : 1}
      padding={inset ? space.roomy : space.major}
      style={{ alignItems: 'center' }}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: c.surfaceElevated,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={24} color={c.tertiaryText} />
      </View>

      <Text variant="subheading" align="center" style={{ marginTop: space.comfy }}>
        {title}
      </Text>

      {body ? (
        <Text
          variant="bodySmall"
          color="tertiaryText"
          align="center"
          style={{ marginTop: space.tight, maxWidth: 280 }}
        >
          {body}
        </Text>
      ) : null}

      {actionLabel && onAction ? (
        <Button
          title={actionLabel}
          onPress={onAction}
          size="sm"
          style={{ marginTop: space.roomy }}
        />
      ) : null}
    </Surface>
  );
}

export default EmptyState;
