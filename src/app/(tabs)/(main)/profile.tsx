/**
 * Profile — account and settings.
 *
 * Rebuilt on the v2 adapter and the design system. The previous version was ~900
 * lines built around the deleted v1 API: it fetched `/profile`, managed bank
 * accounts inline through three full-screen modals, and offered an avatar upload
 * and a change-password flow.
 *
 * What went and why:
 *
 *  - **Change password.** v2 is passwordless (ARCHITECTURE.md §10). There is no
 *    password to change, so the row was offering a thing that cannot exist.
 *  - **Edit profile / avatar upload.** Phone signup collects no name, and the
 *    server holds no display name to edit. Rows that open a form for fields the
 *    backend doesn't store are worse than no rows.
 *  - **Inline bank-account modals.** Bank accounts have their own screen, reached
 *    from here and from withdraw, using one shared form. Managing them in two
 *    places is how the two drift apart.
 *  - **Three "Coming soon" alerts.** A menu row that apologises is a menu row
 *    that shouldn't be rendered yet.
 *
 * What's left is what the app can actually honour: identity, where money goes,
 * the security controls that exist, appearance, and sign out.
 */

import { useCallback } from 'react';
import { Alert, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  Badge,
  Money,
  Screen,
  Section,
  Skeleton,
  Stagger,
  Surface,
  Text,
  useToast,
} from '@/components/ui';
import { useBankAccounts, useLimits, usePortfolio } from '@/hooks/useExchange';
import { signOutCompletely } from '@/services/sessionReset';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';

export default function ProfileScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { c, space } = useTheme();
  const { show } = useToast();

  const user = useAuthStore((s) => s.user);
  const mode = useAppStore((s) => s.mode);
  const toggleMode = useAppStore((s) => s.toggleMode);
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
          // Clear cached balances and activity — the next person to sign in on
          // this device must not see the previous user's money.
          queryClient.clear();
          router.replace('/(auth)/welcome');
        },
      },
    ]);
  }, [queryClient, router]);

  // Phone signup collects no name, so fall back through what we might have.
  const displayName = user?.name || user?.username || user?.phone || 'Your account';
  const tier = limits.data?.kycTier ?? user?.kycTier ?? 0;
  const bankCount = accounts.data?.length ?? 0;

  return (
    <Screen tabBarClearance>
      <View style={{ marginTop: space.snug, marginBottom: space.roomy }}>
        <Text variant="title">Profile</Text>
      </View>

      {/* Identity. An avatar would be decoration — there's no photo to show and
          no way to set one — so the initial does the job at a fraction of the
          space. */}
      <Stagger index={0}>
        <Surface level={1} style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}>
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 26,
              backgroundColor: c.accentDim,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text variant="heading" color="primaryAccent">
              {displayName.trim().charAt(0).toUpperCase()}
            </Text>
          </View>

          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="subheading" numberOfLines={1}>
              {displayName}
            </Text>
            {user?.phone || user?.email ? (
              <Text
                variant="amountSmall"
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
        </Surface>
      </Stagger>

      {/* Balance restated here so the profile answers "what do I have" without a
          trip back to home. */}
      <Stagger index={1}>
        <Section title="Balance">
          <Surface level={1} style={{ gap: space.tight }}>
            <Text variant="eyebrow" color="tertiaryText">
              Available
            </Text>
            {portfolio.isLoading ? (
              <Skeleton width={170} height={30} radius={8} />
            ) : (
              <Money value={Number(portfolio.data?.ngnBalance ?? 0)} variant="figure" />
            )}
            {limits.data ? (
              <Text variant="caption" color="tertiaryText">
                ₦{Number(limits.data.dailyRemainingNgn).toLocaleString('en-NG')} of today’s
                withdrawal limit left
              </Text>
            ) : null}
          </Surface>
        </Section>
      </Stagger>

      <Stagger index={2}>
        <Section title="Money">
          <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
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
          </Surface>
        </Section>
      </Stagger>

      <Stagger index={3}>
        <Section title="Security">
          <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
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
          </Surface>
        </Section>
      </Stagger>

      <Stagger index={4}>
        <Section title="App">
          <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
            <ToggleRow
              icon={mode === 'dark' ? 'moon-outline' : 'sunny-outline'}
              label="Dark mode"
              value={mode === 'dark'}
              onValueChange={toggleMode}
            />
            <Row
              icon="chatbubble-ellipses-outline"
              label="Get help"
              detail="We reply within an hour"
              onPress={() => show('Support chat is coming soon')}
              last
            />
          </Surface>
        </Section>
      </Stagger>

      <Stagger index={5}>
        <Surface
          level={1}
          onPress={signOut}
          style={{
            marginTop: space.roomy,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: space.snug,
          }}
          accessibilityLabel="Sign out"
        >
          <Ionicons name="log-out-outline" size={18} color={c.negative} />
          <Text variant="action" color="negative">
            Sign out
          </Text>
        </Surface>
      </Stagger>
    </Screen>
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
  const { c, space } = useTheme();

  return (
    <Surface
      level={0}
      padding={0}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.base,
        paddingVertical: space.base,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <Ionicons name={icon} size={19} color={c.secondaryText} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="subheading">{label}</Text>
        {detail ? (
          <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={17} color={c.quaternaryText} />
    </Surface>
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
  const { c, space } = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.base,
        paddingVertical: space.base,
        ...(last ? null : { borderBottomWidth: 1, borderBottomColor: c.hairline }),
      }}
    >
      <Ionicons name={icon} size={19} color={c.secondaryText} />
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
