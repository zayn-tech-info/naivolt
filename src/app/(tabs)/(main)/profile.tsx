/**
 * Profile — account and settings.
 *
 * Restyled to the sharp Convert / Sell / Activity / Home system. Vertical
 * rhythm between blocks is one spacing token (space.comfy). Account and
 * balance cards share the same padding, radius, and border treatment.
 */

import { useCallback, type ReactNode } from 'react';
import { Alert, Pressable, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  Badge,
  Money,
  Screen,
  SegmentedControl,
  Skeleton,
  Stagger,
  Text,
  TopLevelHeader,
  useToast,
} from '@/components/ui';
import { useBankAccounts, useLimits, usePortfolio } from '@/hooks/useExchange';
import { signOutCompletely } from '@/services/sessionReset';
import { useAppStore, type ThemePreference } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';


export default function ProfileScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { c, radius, space } = useTheme();
  const { show } = useToast();

  const user = useAuthStore((s) => s.user);
  const themePreference = useAppStore((s) => s.themePreference);
  const setMode = useAppStore((s) => s.setMode);
  const balanceHidden = useAppStore((s) => s.balanceHidden);
  const toggleBalanceHidden = useAppStore((s) => s.toggleBalanceHidden);

  const portfolio = usePortfolio();
  const accounts = useBankAccounts();
  const limits = useLimits();

  const signOut = useCallback(() => {
    Alert.alert('Sign out?', 'You’ll need to verify your phone again to get back in.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await signOutCompletely();
          useAuthStore.getState().logout();
          queryClient.clear();
          router.replace('/(auth)/register');
        },
      },
    ]);
  }, [queryClient, router]);

  const displayName = user?.name || user?.username || user?.phone || 'Your account';
  const tier = limits.data?.kycTier ?? user?.kycTier ?? 0;
  const bankCount = accounts.data?.length ?? 0;

  return (
    <Screen tabBarClearance>
      <TopLevelHeader title="Profile" supportingText="Account, security, and app preferences" />

      <View style={{ marginTop: space.comfy, gap: space.comfy }}>
        {/* Account */}
        <Stagger index={0}>
          <Card>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.comfy,
              }}
            >
              <View
                style={{
                  width: space.major,
                  height: space.major,
                  borderRadius: radius.card,
                  backgroundColor: c.accentDim,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text variant="subheading" color="primaryAccent">
                  {displayName.trim().charAt(0).toUpperCase()}
                </Text>
              </View>

              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="subheading" numberOfLines={1}>
                  {displayName}
                </Text>
                {user?.phone || user?.email ? (
                  <Text
                    variant="caption"
                    color="tertiaryText"
                    numberOfLines={1}
                    style={{ marginTop: 2 }}
                  >
                    {user.phone ?? user.email}
                  </Text>
                ) : null}
              </View>

              <Badge
                label={tier > 0 ? `Tier ${tier}` : 'Unverified'}
                tone={tier > 0 ? 'positive' : 'warning'}
              />
            </View>
          </Card>
        </Stagger>

        {/* Balance */}
        <Stagger index={1}>
          <Block title="Balance">
            <Card>
              <Text variant="eyebrow" color="tertiaryText">
                Available
              </Text>
              {portfolio.isLoading ? (
                <Skeleton width={170} height={30} radius={radius.card} style={{ marginTop: space.snug }} />
              ) : (
                <Money
                  value={Number(portfolio.data?.ngnBalance ?? 0)}
                  variant="figure"
                  style={{ marginTop: space.snug }}
                />
              )}
              {limits.data ? (
                <Text variant="caption" color="tertiaryText" style={{ marginTop: space.snug }}>
                  ₦{Number(limits.data.dailyRemainingNgn).toLocaleString('en-NG')} of today’s
                  withdrawal limit left
                </Text>
              ) : null}
            </Card>
          </Block>
        </Stagger>

        {/* Money */}
        <Stagger index={2}>
          <Block title="Money">
            <ListCard>
              <Row
                icon="business-outline"
                label="Bank accounts"
                detail={
                  accounts.isLoading
                    ? undefined
                    : bankCount === 0
                      ? 'None yet'
                      : `${bankCount} saved`
                }
                onPress={() => router.push('/bank-details')}
              />
              <Row
                icon="receipt-outline"
                label="Activity"
                detail="Deposits, cards, withdrawals"
                onPress={() => router.push('/(tabs)/(main)/history')}
                last
              />
            </ListCard>
          </Block>
        </Stagger>

        {/* Security */}
        <Stagger index={3}>
          <Block title="Security">
            <ListCard>
              <Row
                icon="keypad-outline"
                label="Change PIN"
                detail="Used for every withdrawal"
                onPress={() => router.push('/(auth)/set-pin')}
              />
              <ToggleRow
                icon="eye-off-outline"
                label="Hide balance"
                detail="Mask amounts on the home screen"
                value={balanceHidden}
                onValueChange={toggleBalanceHidden}
                last
              />
            </ListCard>
          </Block>
        </Stagger>

        {/* App */}
        <Stagger index={4}>
          <Block title="App">
            <ListCard>
              <View style={{ paddingVertical: space.comfy, gap: space.base }}>
                <View style={{ gap: space.tight }}>
                  <Text variant="subheading">Appearance</Text>
                  <Text variant="caption" color="tertiaryText">
                    Follow your device or keep a theme you prefer.
                  </Text>
                </View>
                <SegmentedControl<ThemePreference>
                  segments={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                  value={themePreference}
                  onChange={setMode}
                />
              </View>
              <Row
                icon="chatbubble-ellipses-outline"
                label="Get help"
                detail="We reply within an hour"
                onPress={() => show('Support chat is coming soon')}
                last
              />
            </ListCard>
          </Block>
        </Stagger>

        {/* Sign out */}
        <Stagger index={5}>
          <Card onPress={signOut} accessibilityLabel="Sign out">
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: space.snug,
                minHeight: space.spacious,
              }}
            >
              <Ionicons name="log-out-outline" size={18} color={c.danger} />
              <Text variant="subheading" color="danger">
                Sign out
              </Text>
            </View>
          </Card>
        </Stagger>
      </View>
    </Screen>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  const { space } = useTheme();
  return (
    <View style={{ gap: space.base }}>
      <Text variant="eyebrow" color="tertiaryText">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Card({
  children,
  onPress,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const { c, radius, space, minTouch } = useTheme();
  const shell = {
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.surface,
    padding: space.comfy,
  } as const;

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [shell, { opacity: pressed ? 0.85 : 1, minHeight: minTouch }]}
      >
        {children}
      </Pressable>
    );
  }

  return <View style={shell}>{children}</View>;
}

function ListCard({ children }: { children: ReactNode }) {
  const { c, radius, space } = useTheme();
  return (
    <View
      style={{
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: c.hairline,
        backgroundColor: c.surface,
        overflow: 'hidden',
        paddingHorizontal: space.comfy,
      }}
    >
      {children}
    </View>
  );
}

function IconWell({ name }: { name: React.ComponentProps<typeof Ionicons>['name'] }) {
  const { c, radius, iconSize } = useTheme();
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: radius.card,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.surfaceSunken,
        borderWidth: 1,
        borderColor: c.hairline,
      }}
    >
      <Ionicons name={name} size={iconSize.medium} color={c.secondaryText} />
    </View>
  );
}

function Row({
  icon,
  label,
  detail,
  onPress,
  last = false,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  detail?: string;
  onPress: () => void;
  last?: boolean;
}) {
  const { c, radius, space, minTouch } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        minHeight: minTouch + 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.comfy,
        paddingVertical: space.comfy,
        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      })}
    >
      <IconWell name={icon} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="subheading">{label}</Text>
        {detail ? (
          <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={c.quaternaryText} />
    </Pressable>
  );
}

function ToggleRow({
  icon,
  label,
  detail,
  value,
  onValueChange,
  last = false,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  detail?: string;
  value: boolean;
  onValueChange: () => void;
  last?: boolean;
}) {
  const { c, radius, space, minTouch } = useTheme();

  return (
    <View
      style={{
        minHeight: minTouch + 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.comfy,
        paddingVertical: space.comfy,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <IconWell name={icon} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="subheading">{label}</Text>
        {detail ? (
          <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: c.borderLight, true: c.primaryAccent }}
        thumbColor={value ? c.buttonTextOnAccent : c.surface}
        accessibilityLabel={label}
      />
    </View>
  );
}
