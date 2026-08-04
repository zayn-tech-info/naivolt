/**
 * ActionBar — equal quick actions under the balance.
 *
 * Each action uses the shared neutral icon well and has equal horizontal room.
 */

import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { QuickAction } from '@/components/ui';

export interface Action {
  key: string;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  accessibilityHint?: string;
}

export interface ActionBarProps {
  actions: Action[];
}

export function ActionBar({ actions }: ActionBarProps) {
  const { space } = useTheme();

  return (
    <View style={{ flexDirection: 'row', gap: space.base }}>
      {actions.map((action) => (
        <QuickAction
          key={action.key}
          icon={action.icon}
          label={action.label}
          onPress={action.onPress}
          accessibilityHint={action.accessibilityHint}
          tone="neutral"
        />
      ))}
    </View>
  );
}

export default ActionBar;
