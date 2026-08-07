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

import { useCallback, useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  Avatar,
  Badge,
  Button,
  Input,
  Money,
  Screen,
  Section,
  Skeleton,
  Stagger,
  Surface,
  Text,
  useToast,
} from '@/components/ui';
import {
  useBankAccounts,
  useKycStatus,
  useLimits,
  useMe,
  usePortfolio,
  useUpdateMe,
} from '@/hooks/useExchange';
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
  const kyc = useKycStatus();
  const me = useMe();
  const updateMe = useUpdateMe();

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

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
          // Sign-up and sign-in are one screen; there is no separate welcome.
          router.replace('/(auth)/register');
        },
      },
    ]);
  }, [queryClient, router]);

  const saveName = useCallback(async () => {
    try {
      await updateMe.mutateAsync({ displayName: nameDraft.trim() });
      setEditingName(false);
      show('Name saved', 'positive');
    } catch (err) {
      show((err as { message?: string }).message ?? 'Could not save that name.', 'negative');
    }
  }, [updateMe, nameDraft, show]);
  // Live, not the tier baked into the access token — that can be up to 15
  // minutes stale and this row is how someone checks whether verifying worked.
  const tier = kyc.data?.tier ?? limits.data?.kycTier ?? user?.kycTier ?? 0;
  const bankCount = accounts.data?.length ?? 0;

  return (
    <Screen tabBarClearance>
      <View style={{ marginTop: space.snug, marginBottom: space.roomy }}>
        <Text variant="title">Profile</Text>
      </View>

      {/* Identity. Tapping it edits the name — the profile header is where
          someone looks to change what they're called, so making it the control
          avoids a settings row that does the same thing one level deeper. */}
      <Stagger index={0}>
        <Surface
          level={1}
          onPress={() => {
            setNameDraft(me.data?.displayName ?? '');
            setEditingName(true);
          }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}
          accessibilityLabel="Edit your name"
        >
          <Avatar name={me.data?.displayName} seed={me.data?.avatarSeed} size={52} />

          <View style={{ flex: 1, minWidth: 0 }}>
            {me.data?.displayName ? (
              <Text variant="subheading" numberOfLines={1}>
                {me.data.displayName}
              </Text>
            ) : (
              // Not a placeholder name. An unnamed account should say so and
              // offer the fix, rather than showing "there" as if it were a name.
              <Text variant="subheading" color="primaryAccent" numberOfLines={1}>
                Add your name
              </Text>
            )}
            {me.data?.phone || me.data?.email ? (
              <Text
                variant="amountSmall"
                color="tertiaryText"
                numberOfLines={1}
                style={{ marginTop: 2 }}
              >
                {me.data.phone ?? me.data.email}
              </Text>
            ) : null}
          </View>

          <Badge
            label={tier > 0 ? `Tier ${tier}` : 'Unverified'}
            tone={tier > 0 ? 'positive' : 'warning'}
          />
        </Surface>
      </Stagger>

      {/* Inline rather than a separate screen: one field, and pushing a route
          for it would lose the context of what is being renamed. */}
      {editingName ? (
        <Surface level={1} style={{ marginTop: space.base, gap: space.snug }}>
          <Input
            label="Your name"
            value={nameDraft}
            onChangeText={setNameDraft}
            placeholder="Adeyemi Divine"
            autoCapitalize="words"
            autoCorrect={false}
            autoFocus
            hint="Used to greet you. Verification uses the name on your ID."
            containerStyle={{ marginBottom: 0 }}
          />
          <View style={{ flexDirection: 'row', gap: space.snug }}>
            <Button
              title="Cancel"
              variant="ghost"
              onPress={() => setEditingName(false)}
              style={{ flex: 1 }}
            />
            <Button
              title="Save"
              onPress={saveName}
              disabled={!nameDraft.trim()}
              loading={updateMe.isPending}
              style={{ flex: 1 }}
            />
          </View>
        </Surface>
      ) : null}

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
        <Section title="Account">
          <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
            <Row
              icon="shield-checkmark-outline"
              label="Verification"
              detail={
                kyc.data
                  ? kyc.data.canWithdraw
                    ? `Tier ${tier} · ₦${Number(kyc.data.dailyLimitNgn).toLocaleString('en-NG')} a day`
                    : 'Required before you can withdraw'
                  : undefined
              }
              onPress={() => router.push('/kyc')}
              last
            />
          </Surface>
        </Section>
      </Stagger>

      <Stagger index={3}>
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

      <Stagger index={4}>
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

      <Stagger index={5}>
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

      <Stagger index={6}>
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
