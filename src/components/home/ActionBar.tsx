/**
 * ActionBar — the three things a user can do.
 *
 * Deposit, Sell, Withdraw is the entire product loop, so all three sit at the
 * same level directly under the balance rather than one being a hero button and
 * the others buried in a menu.
 *
 * Only one carries the lime: Sell is where the business earns its spread, and
 * it's the action a user with a funded balance most likely came to take. The
 * other two are legible but quiet, which is what the accent discipline buys —
 * with everything lime, nothing is.
 */

import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Surface, Text } from '@/components/ui';

export interface Action {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  /** The one action that carries the accent. */
  primary?: boolean;
  disabled?: boolean;
}

export function ActionBar({ actions }: { actions: Action[] }) {
  const { c, space, disabledOpacity } = useTheme();

  return (
    <View style={{ flexDirection: 'row', gap: space.base }}>
      {actions.map((action) => {
        const fg = action.primary ? c.buttonTextOnAccent : c.primaryText;
        return (
          <Surface
            key={action.key}
            level={action.primary ? 0 : 2}
            radiusToken="tile"
            padding={space.comfy}
            onPress={action.disabled ? undefined : action.onPress}
            style={{
              flex: 1,
              alignItems: 'center',
              gap: space.snug,
              ...(action.primary ? { backgroundColor: c.primaryAccent } : null),
              ...(action.disabled ? { opacity: disabledOpacity } : null),
            }}
            accessibilityLabel={action.label}
          >
            <Ionicons name={action.icon} size={21} color={fg} />
            <Text variant="label" color={fg}>
              {action.label}
            </Text>
          </Surface>
        );
      })}
    </View>
  );
}

export default ActionBar;
