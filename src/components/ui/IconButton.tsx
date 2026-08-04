import { Pressable, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/design';

export interface IconButtonProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  hint?: string;
  selected?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}

export function IconButton({ icon, label, onPress, hint, selected = false, disabled = false, style }: IconButtonProps) {
  const { c, iconSize, minTouch, radius, disabledOpacity } = useTheme();

  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled, selected }}
      style={({ pressed }) => [
        {
          width: minTouch,
          height: minTouch,
          borderRadius: radius.chip,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: selected ? c.accentDim : c.surfaceElevated,
          borderWidth: 1,
          borderColor: selected ? c.accentEdge : c.border,
          opacity: disabled ? disabledOpacity : pressed ? 0.72 : 1,
        },
        style,
      ]}
    >
      <Ionicons name={icon} size={iconSize.medium} color={selected ? c.primaryAccent : c.primaryText} />
    </Pressable>
  );
}

export default IconButton;
