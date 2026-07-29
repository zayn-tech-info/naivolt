/**
 * ScreenHeader — a back affordance and a title.
 *
 * The stack renders headerShown:false throughout, so each pushed screen was
 * drawing its own header slightly differently. This is that header, once.
 */

import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import Text from '@/components/ui/Text';

export interface ScreenHeaderProps {
  title?: string;
  onBack?: () => void;
  /** Optional control at the trailing edge. */
  action?: React.ReactNode;
}

export function ScreenHeader({ title, onBack, action }: ScreenHeaderProps) {
  const { c, space, hitSlop } = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.base,
        height: 48,
        marginBottom: space.snug,
      }}
    >
      {onBack ? (
        <Pressable
          onPress={onBack}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: c.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="chevron-back" size={19} color={c.primaryText} />
        </Pressable>
      ) : null}

      {title ? (
        <Text variant="heading" style={{ flex: 1 }} numberOfLines={1}>
          {title}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}

      {action}
    </View>
  );
}

export default ScreenHeader;
