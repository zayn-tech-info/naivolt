/**
 * QuickAction — equal-weight icon + label for home action rows.
 *
 * Shared card radius well, hairline edge, accent icon.
 */

import { Pressable, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/design';
import { Text } from './Text';


export interface QuickActionProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
  /** @deprecated Kept for callers; always renders the neutral well. */
  tone?: 'neutral' | 'contrast';
  style?: ViewStyle;
}

export function QuickAction({
  icon,
  label,
  onPress,
  accessibilityHint,
  style,
}: QuickActionProps) {
  const { c, radius, iconSize, minTouch, space } = useTheme();

  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        {
          flex: 1,
          minWidth: minTouch,
          minHeight: minTouch + space.generous,
          alignItems: 'center',
          opacity: pressed ? 0.82 : 1,
        },
        style,
      ]}
    >
      <View
        style={{
          width: minTouch,
          height: minTouch,
          borderRadius: radius.card,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: c.surfaceSunken,
          borderWidth: 1,
          borderColor: c.hairline,
        }}
      >
        <Ionicons name={icon} size={iconSize.large} color={c.primaryAccent} />
      </View>
      <Text variant="caption" color="secondaryText" align="center" style={{ marginTop: space.snug }}>
        {label}
      </Text>
    </Pressable>
  );
}

export default QuickAction;
