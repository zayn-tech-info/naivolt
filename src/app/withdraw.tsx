/**
 * Withdraw — naira to a bank account.
 *
 * Two destination modes: a saved beneficiary, or any account the user types.
 * They're a segmented choice rather than a beneficiary list with a "new" row
 * tacked on the end, because entering a new account is a multi-field flow with a
 * name-enquiry step and it deserves its own space — not a row that expands and
 * pushes everything below it around.
 *
 * Beneficiaries come back most-recently-paid first, so the common case (paying
 * the same account again) is the top row.
 *
 * Two stages: compose, then authorise with a PIN. Separate because the PIN should
 * be entered against a frozen summary of exactly what it authorises — amount,
 * destination, account name, fee — not while the amount is still editable.
 *
 * The idempotency key is minted once when the user reaches the PIN stage and
 * reused for every submit attempt, including after a wrong PIN. That's the point
 * of it: a wrong-PIN retry, a timeout, or a dropped response all carry the same
 * key, so the backend can recognise one intent and never pay twice
 * (ARCHITECTURE.md §8.3).
 *
 * Note for the backend: §8 lists a name-match between the destination account and
 * the KYC name as a payout guard. Sending to an arbitrary third party is exactly
 * what that blocks, so whether this flow is allowed — and under which KYC tier —
 * is a deliberate decision, not something this screen should assume. See
 * docs/API-CONTRACT.md §11.
 */

import { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
  Button,
  EmptyState,
  FieldAction,
  Input,
  Money,
  PinPad,
  Screen,
  Section,
  SegmentedControl,
  Skeleton,
  Stagger,
  Surface,
  Text,
  useToast,
} from '@/components/ui';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { BeneficiaryRow } from '@/components/banking/BeneficiaryRow';
import { NewAccountForm, type NewAccountValue } from '@/components/banking/NewAccountForm';
import { useBankAccounts, useCreatePayout, useLimits, usePortfolio } from '@/hooks/useExchange';
import { useEnsurePush } from '@/hooks/useEnsurePush';
import type { PayoutDestination } from '@/services/v2/types';

type Stage = 'compose' | 'authorise';
type Mode = 'saved' | 'new';

/** What the PIN screen is authorising, resolved from either mode. */
interface Destination {
  payload: PayoutDestination;
  bankName: string;
  accountNumber: string;
  accountName: string;
}

export default function WithdrawScreen() {
  const router = useRouter();
  const { c, space } = useTheme();
  const { show } = useToast();
  const ensurePush = useEnsurePush();

  const portfolio = usePortfolio();
  const beneficiaries = useBankAccounts();
  const limits = useLimits();
  const payout = useCreatePayout();

  const [stage, setStage] = useState<Stage>('compose');
  const [mode, setMode] = useState<Mode>('saved');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [newAccount, setNewAccount] = useState<NewAccountValue | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const accounts = beneficiaries.data ?? [];
  const hasSaved = accounts.length > 0;

  // With nothing saved, "saved" is not a real option — start on the new form.
  const effectiveMode: Mode = hasSaved ? mode : 'new';

  const selected = accounts.find((a) => a.id === accountId) ?? accounts[0];

  const ngnBalance = Number(portfolio.data?.ngnBalance ?? 0);
  const entered = Number(amount) || 0;
  const perTxMax = Number(limits.data?.perTransactionMaxNgn ?? 0);
  const minWithdrawal = Number(limits.data?.minWithdrawalNgn ?? 0);
  const dailyRemaining = Number(limits.data?.dailyRemainingNgn ?? 0);

  const problem = useMemo(() => {
    if (!entered) return null;
    if (entered > ngnBalance) return 'That is more than your naira balance.';
    if (minWithdrawal && entered < minWithdrawal)
      return `The minimum withdrawal is ₦${minWithdrawal.toLocaleString('en-NG')}.`;
    if (perTxMax && entered > perTxMax)
      return `Single transfers are capped at ₦${perTxMax.toLocaleString('en-NG')}.`;
    if (dailyRemaining && entered > dailyRemaining)
      return `You have ₦${dailyRemaining.toLocaleString('en-NG')} left in today's limit.`;
    return null;
  }, [entered, ngnBalance, minWithdrawal, perTxMax, dailyRemaining]);

  const destination: Destination | null = useMemo(() => {
    if (effectiveMode === 'saved') {
      if (!selected) return null;
      return {
        payload: { kind: 'beneficiary', bankAccountId: selected.id },
        bankName: selected.bankName,
        accountNumber: selected.accountNumber,
        accountName: selected.accountName,
      };
    }
    if (!newAccount) return null;
    return {
      payload: {
        kind: 'oneOff',
        bankCode: newAccount.bankCode,
        accountNumber: newAccount.accountNumber,
        accountName: newAccount.accountName,
        save: newAccount.save,
      },
      bankName: newAccount.bankName,
      accountNumber: newAccount.accountNumber,
      accountName: newAccount.accountName,
    };
  }, [effectiveMode, selected, newAccount]);

  const canProceed = entered > 0 && !problem && !!destination;

  const goToAuthorise = useCallback(() => {
    // One key per intent, minted here and reused across every submit attempt.
    setIdempotencyKey(Crypto.randomUUID());
    setPin('');
    setPinError(false);
    setStage('authorise');
  }, []);

  const submit = useCallback(
    async (enteredPin: string) => {
      if (!destination || !idempotencyKey) return;
      try {
        const result = await payout.mutateAsync({
          amountNgn: String(entered),
          destination: destination.payload,
          pin: enteredPin,
          idempotencyKey,
        });
        // The toast below promises a notification when it settles. Ask now,
        // while that promise is on screen and the prompt explains itself.
        void ensurePush();
        show(
          `₦${Number(result.amountNgn).toLocaleString('en-NG')} on its way to ${result.bankAccount.bankName}`,
          'positive'
        );
        router.back();
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === 'PIN_INVALID' || e.code === 'PIN_LOCKED') {
          setPinError(true);
          return;
        }
        // Anything not PIN-related is a problem with the transfer itself, so
        // return to the form where the user can change it.
        setStage('compose');
        show(e.message ?? 'That transfer did not go through.', 'negative');
      }
    },
    [destination, idempotencyKey, entered, payout, show, router, ensurePush]
  );

  // ── Authorise ───────────────────────────────────────────────────────
  if (stage === 'authorise' && destination) {
    return (
      <Screen edges={['top']} scroll={false}>
        <ScreenHeader
          onBack={() => {
            setStage('compose');
            setPin('');
          }}
        />

        <View style={{ flex: 1, justifyContent: 'space-between', paddingBottom: space.roomy }}>
          <View style={{ alignItems: 'center', gap: space.tight }}>
            <Text variant="eyebrow" color="tertiaryText">
              Confirm with your PIN
            </Text>
            <Money value={entered} variant="figure" />

            {/* Full destination, unmasked. This is the last chance to catch a
                wrong account, so nothing here is abbreviated. */}
            <Text variant="subheading" align="center" style={{ marginTop: space.snug }}>
              {destination.accountName}
            </Text>
            <Text variant="amountSmall" color="secondaryText" align="center">
              {destination.bankName} · {destination.accountNumber}
            </Text>
          </View>

          <PinPad
            value={pin}
            onChange={setPin}
            error={pinError}
            onErrorShown={() => setPinError(false)}
            onComplete={submit}
          />

          <View style={{ minHeight: 20, alignItems: 'center' }}>
            {payout.isPending ? (
              <Text variant="caption" color="tertiaryText">
                Sending…
              </Text>
            ) : pinError ? (
              <Text variant="caption" color="negative">
                Wrong PIN. Try again.
              </Text>
            ) : null}
          </View>
        </View>
      </Screen>
    );
  }

  // ── Compose ─────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen edges={['top']}>
        <ScreenHeader title="Withdraw naira" onBack={() => router.back()} />

        <Stagger index={0}>
          <Surface level={1} style={{ alignItems: 'center', gap: 4, marginTop: space.snug }}>
            <Text variant="eyebrow" color="tertiaryText">
              Available
            </Text>
            {portfolio.isLoading ? (
              <Skeleton width={170} height={30} radius={8} />
            ) : (
              <Money value={ngnBalance} variant="figure" />
            )}
          </Surface>
        </Stagger>

        <Stagger index={1}>
          <Section title="Amount">
            <Input
              value={amount}
              onChangeText={setAmount}
              placeholder="0.00"
              keyboardType="decimal-pad"
              mono
              prefix="₦"
              error={problem ?? undefined}
              hint={
                limits.data
                  ? `₦${dailyRemaining.toLocaleString('en-NG')} left in today's limit`
                  : undefined
              }
              trailing={
                <FieldAction
                  label="Max"
                  onPress={() =>
                    setAmount(String(Math.min(ngnBalance, perTxMax || ngnBalance)))
                  }
                />
              }
            />
          </Section>
        </Stagger>

        <Stagger index={2}>
          <Section title="Send to">
            {hasSaved ? (
              <View style={{ marginBottom: space.comfy }}>
                <SegmentedControl
                  segments={[
                    { value: 'saved', label: 'Beneficiaries' },
                    { value: 'new', label: 'New account' },
                  ]}
                  value={effectiveMode}
                  onChange={setMode}
                />
              </View>
            ) : null}

            {beneficiaries.isLoading ? (
              <View style={{ gap: space.snug }}>
                {[0, 1].map((i) => (
                  <Skeleton key={i} width="100%" height={68} radius={16} />
                ))}
              </View>
            ) : effectiveMode === 'saved' ? (
              <View style={{ gap: space.snug }}>
                {accounts.map((account, i) => (
                  <BeneficiaryRow
                    key={account.id}
                    account={account}
                    selected={selected?.id === account.id}
                    recent={i === 0 && !!account.lastUsedAt}
                    onPress={() => setAccountId(account.id)}
                  />
                ))}
              </View>
            ) : (
              <>
                {!hasSaved ? (
                  <View style={{ marginBottom: space.comfy }}>
                    <EmptyState
                      icon="people-outline"
                      title="No saved accounts yet"
                      body="Enter the account below. You can save it for next time."
                      inset
                    />
                  </View>
                ) : null}
                <NewAccountForm onChange={setNewAccount} />
              </>
            )}
          </Section>
        </Stagger>

        {/* Fee and net, once there's an amount worth breaking down. */}
        {entered > 0 && !problem ? (
          <Stagger index={3}>
            <Surface level={1} style={{ marginTop: space.roomy, gap: space.snug }}>
              <Row label="From your balance" value={`₦${entered.toLocaleString('en-NG')}`} />
              {/* Naivolt absorbs the provider fee — it books to payout_fee_expense
                  against the float, not to the user (ARCHITECTURE.md §5, J5). So
                  the amount sent and the amount received are the same figure, and
                  inventing a fee line here would be a lie. */}
              <Row label="Transfer fee" value="Free" />
              <View style={{ height: 1, backgroundColor: c.hairline, marginVertical: 2 }} />
              <Row
                label={effectiveMode === 'new' ? 'They receive' : 'You receive'}
                value={`₦${entered.toLocaleString('en-NG')}`}
                emphasis
              />
            </Surface>
          </Stagger>
        ) : null}

        <View
          style={{
            flexDirection: 'row',
            gap: space.snug,
            marginTop: space.roomy,
            paddingHorizontal: space.tight,
          }}
        >
          <Ionicons name="time-outline" size={13} color={c.tertiaryText} />
          <Text variant="caption" color="tertiaryText" style={{ flex: 1 }}>
            Transfers usually land within minutes. You’ll get a notification when it settles.
          </Text>
        </View>

        <Button
          title="Continue"
          onPress={goToAuthorise}
          disabled={!canProceed}
          size="lg"
          fullWidth
          style={{ marginTop: space.roomy }}
        />
      </Screen>
    </KeyboardAvoidingView>
  );
}

function Row({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text variant="bodySmall" color={emphasis ? 'primaryText' : 'secondaryText'}>
        {label}
      </Text>
      <Text variant={emphasis ? 'amount' : 'amountSmall'}>{value}</Text>
    </View>
  );
}
