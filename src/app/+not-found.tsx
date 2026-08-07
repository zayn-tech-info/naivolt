/**
 * Unmatched route.
 *
 * Reachable from a stale deep link or a notification pointing at something that
 * has since been removed, so it offers a way back rather than only stating the
 * problem.
 */

import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/design';
import { Button, Screen, Text } from '@/components/ui';

export default function NotFoundScreen() {
  const router = useRouter();
  const { space } = useTheme();

  return (
    <Screen edges={['top']} scroll={false}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: space.base,
        }}
      >
        <Text variant="title" align="center">
          Page not found
        </Text>
        <Text variant="body" color="secondaryText" align="center" style={{ maxWidth: 280 }}>
          That link doesn’t go anywhere. It may have been removed.
        </Text>

        <Button
          title="Go home"
          onPress={() => router.replace('/(tabs)/(main)')}
          size="lg"
          style={{ marginTop: space.comfy, minWidth: 200 }}
        />
      </View>
    </Screen>
  );
}
