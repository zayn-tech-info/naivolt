import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Button } from './Button';
import { Text } from './Text';

export type FeedbackTone = 'neutral' | 'success' | 'error';

export interface FeedbackStateProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
  tone?: FeedbackTone;
  actionLabel?: string;
  onAction?: () => void;
}

export function FeedbackState({ icon, title, body, tone = 'neutral', actionLabel, onAction }: FeedbackStateProps) {
  const { c, iconSize, radius, space } = useTheme();
  const color = tone === 'success' ? c.positive : tone === 'error' ? c.negative : c.primaryAccent;

  return (
    <View style={{ alignItems: 'center', paddingVertical: space.spacious }}>
      <View
        style={{
          width: space.hero,
          height: space.hero,
          borderRadius: radius.chip,
          backgroundColor: tone === 'error' ? c.negativeDim : tone === 'success' ? c.positiveDim : c.accentDim,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={iconSize.large} color={color} />
      </View>
      <Text variant="heading" align="center" style={{ marginTop: space.comfy }}>{title}</Text>
      <Text variant="body" color="secondaryText" align="center" style={{ marginTop: space.snug }}>{body}</Text>
      {actionLabel && onAction ? <Button title={actionLabel} onPress={onAction} style={{ marginTop: space.roomy }} /> : null}
    </View>
  );
}

export default FeedbackState;
