import { useRouter } from 'expo-router';
import { Button, FeedbackState, Screen } from '@/components/ui';

export default function NotFoundScreen() {
  const router = useRouter();

  return (
    <Screen scroll={false} edges={['top', 'bottom']} contentStyle={{ justifyContent: 'center' }}>
      <FeedbackState
        icon="compass-outline"
        title="Page not found"
        body="The page you are looking for does not exist or has moved."
      />
      <Button title="Go home" onPress={() => router.replace('/')} fullWidth />
    </Screen>
  );
}
