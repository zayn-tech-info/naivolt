import { View } from 'react-native';
import { useTheme } from '@/design';
import { IconButton } from './IconButton';
import { Text } from './Text';

export interface TopLevelHeaderProps {
  title: string;
  supportingText?: string;
  /** Opens Activity (history). Kept as the home trailing control. */
  activityAction?: () => void;
  /**
   * @deprecated Use `activityAction`. Alias retained so older call sites compile.
   */
  notificationAction?: () => void;
}

export function TopLevelHeader({
  title,
  supportingText,
  activityAction,
  notificationAction,
}: TopLevelHeaderProps) {
  const { space } = useTheme();
  const onActivity = activityAction ?? notificationAction;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.base, marginTop: space.tight }}>
      <View style={{ flex: 1 }}>
        <Text variant="heading">{title}</Text>
        {supportingText ? (
          <Text variant="bodySmall" color="secondaryText" style={{ marginTop: space.tight }}>
            {supportingText}
          </Text>
        ) : null}
      </View>
      {onActivity ? (
        <IconButton icon="receipt-outline" label="Open activity" onPress={onActivity} />
      ) : null}
    </View>
  );
}

export interface FlowHeaderProps {
  title?: string;
  onBack?: () => void;
  action?: React.ReactNode;
}

export function FlowHeader({ title, onBack, action }: FlowHeaderProps) {
  const { space, minTouch } = useTheme();

  return (
    <View style={{ minHeight: minTouch, flexDirection: 'row', alignItems: 'center', gap: space.base, marginBottom: space.base }}>
      {onBack ? <IconButton icon="chevron-back" label="Go back" onPress={onBack} /> : null}
      {title ? (
        <Text variant="heading" style={{ flex: 1 }} numberOfLines={2}>
          {title}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      {action}
    </View>
  );
}
