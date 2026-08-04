/**
 * Bank accounts — manage where naira gets paid.
 *
 * Rebuilt on the v2 adapter; the previous 691-line version called the deleted v1
 * API and shipped its own bank picker, account-number field and name-enquiry
 * logic.
 *
 * It now reuses the same `NewAccountForm` the withdraw flow uses, so an account
 * is added through exactly one code path with one name-enquiry gate. Two separate
 * "add a bank account" forms is how one of them ends up missing a validation the
 * other has.
 *
 * Removing an account asks for confirmation, because it's the one destructive
 * action here. That's what `Alert` is actually for — unlike the navigation
 * prompts it was doing elsewhere in this app.
 */

import { useCallback, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  Button,
  EmptyState,
  Screen,
  Section,
  Skeleton,
  Stagger,
  Surface,
  Text,
  useToast,
} from '@/components/ui';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { bankInitials, bankTint } from '@/components/banking/BankPicker';
import { NewAccountForm, type NewAccountValue } from '@/components/banking/NewAccountForm';
import { useAddBankAccount, useBankAccounts, useRemoveBankAccount } from '@/hooks/useExchange';
import type { BankAccount } from '@/services/v2/types';

export default function BankAccountsScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const { show } = useToast();

  const accounts = useBankAccounts();
  const addAccount = useAddBankAccount();
  const removeAccount = useRemoveBankAccount();

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<NewAccountValue | null>(null);

  const list = accounts.data ?? [];

  const save = useCallback(async () => {
    if (!draft) return;
    try {
      await addAccount.mutateAsync({
        bankCode: draft.bankCode,
        accountNumber: draft.accountNumber,
        accountName: draft.accountName,
      });
      show('Bank account saved', 'positive');
      setAdding(false);
      setDraft(null);
    } catch (err) {
      show((err as { message?: string }).message ?? 'Could not save that account.', 'negative');
    }
  }, [draft, addAccount, show]);

  const confirmRemove = useCallback(
    (account: BankAccount) => {
      Alert.alert(
        'Remove account?',
        `${account.bankName} ···${account.accountNumber.slice(-4)} will no longer be available for withdrawals.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              try {
                await removeAccount.mutateAsync(account.id);
                show('Account removed');
              } catch (err) {
                show(
                  (err as { message?: string }).message ?? 'Could not remove that account.',
                  'negative'
                );
              }
            },
          },
        ]
      );
    },
    [removeAccount, show]
  );

  // ── Add ─────────────────────────────────────────────────────────────
  if (adding) {
    return (
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Screen edges={['top']}>
          <ScreenHeader
            title="Add bank account"
            onBack={() => {
              setAdding(false);
              setDraft(null);
            }}
          />

          <View style={{ marginTop: space.snug }}>
            <NewAccountForm onChange={setDraft} />
          </View>

          <Button
            title="Save account"
            onPress={save}
            disabled={!draft}
            loading={addAccount.isPending}
            size="lg"
            fullWidth
            style={{ marginTop: space.roomy }}
          />

          <Text
            variant="caption"
            color="tertiaryText"
            align="center"
            style={{ marginTop: space.base }}
          >
            We check the name with your bank before saving it.
          </Text>
        </Screen>
      </KeyboardAvoidingView>
    );
  }

  // ── List ────────────────────────────────────────────────────────────
  return (
    <Screen edges={['top']}>
      <ScreenHeader title="Bank accounts" onBack={() => router.back()} />

      {accounts.isLoading ? (
        <View style={{ gap: space.snug, marginTop: space.snug }}>
          {[0, 1].map((i) => (
            <Skeleton key={i} width="100%" height={72} radius={16} />
          ))}
        </View>
      ) : list.length === 0 ? (
        <View style={{ marginTop: space.major }}>
          <EmptyState
            icon="business-outline"
            title="No bank account yet"
            body="Add the account you want your naira paid into."
            actionLabel="Add bank account"
            onAction={() => setAdding(true)}
          />
        </View>
      ) : (
        <>
          <Section title="Saved accounts" first>
            <View style={{ gap: space.snug }}>
              {list.map((account, i) => (
                <Stagger key={account.id} index={Math.min(i, 4)}>
                  <AccountCard account={account} onRemove={() => confirmRemove(account)} />
                </Stagger>
              ))}
            </View>
          </Section>

          <Button
            title="Add another account"
            variant="secondary"
            icon="add"
            onPress={() => setAdding(true)}
            fullWidth
            style={{ marginTop: space.roomy }}
          />
        </>
      )}

      <View
        style={{
          flexDirection: 'row',
          gap: space.snug,
          marginTop: space.roomy,
          paddingHorizontal: space.tight,
        }}
      >
        <Ionicons name="shield-checkmark-outline" size={13} color={c.tertiaryText} />
        <Text variant="caption" color="tertiaryText" style={{ flex: 1 }}>
          Withdrawals need your PIN, whichever account you send to.
        </Text>
      </View>
    </Screen>
  );
}

function AccountCard({ account, onRemove }: { account: BankAccount; onRemove: () => void }) {
  const { c, iconSize, minTouch, radius, space, hitSlop } = useTheme();
  const tint = bankTint(account.bankName);

  return (
    <Surface
      level={1}
      radiusToken="tile"
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.base }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.chip,
          backgroundColor: `${tint}22`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text variant="label" color={tint}>
          {bankInitials(account.bankName)}
        </Text>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="subheading" numberOfLines={1}>
          {account.nickname || account.accountName}
        </Text>
        <Text variant="amountSmall" color="tertiaryText" style={{ marginTop: 2 }} numberOfLines={1}>
          {account.bankName} · {account.accountNumber}
        </Text>
      </View>

      <Pressable
        onPress={onRemove}
        hitSlop={hitSlop}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${account.bankName} account`}
        style={{
          width: minTouch,
          height: minTouch,
          borderRadius: radius.chip,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name="trash-outline" size={iconSize.small} color={c.tertiaryText} />
      </Pressable>
    </Surface>
  );
}
