import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { colors } from '@/constants/theme';

interface AvatarProps {
  name?: string;
  size?: number;
  style?: ViewStyle;
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((s) => s[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export default function Avatar({ name = '?', size = 48, style }: AvatarProps) {
  const initials = getInitials(name);

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
        },
        style,
      ]}
    >
      <Text
        style={[
          styles.text,
          { fontSize: size * 0.4, color: colors.primaryAccent },
        ]}
      >
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontWeight: '700',
  },
});