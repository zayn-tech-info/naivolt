/**
 * Verification.
 *
 * Signup asks for nothing; the wall goes up at withdrawal (ARCHITECTURE.md
 * §10.3). So a user arrives here already wanting something specific — to cash
 * out, or to raise a limit they just hit — and the screen is built around
 * answering "what do I get" before "what do you need".
 *
 * That ordering is the whole design. A verification form that opens with a
 * request for a national identity number, from an app that has not yet said what
 * it unlocks, reads as data harvesting. The tier ladder goes first, with the
 * user's current rung marked and the limits stated in naira, and the form comes
 * after.
 *
 * The screen never asks for more than the next tier needs. A single document,
 * one step, rather than a wall of fields for tiers the user may not want.
 *
 * Name and date of birth are not asked for here at all — they live on the
 * profile, which is the one place they are edited. Two places to set a name is
 * how they drift apart, and the copy that matters at payout time is the one the
 * bank account has to match.
 */

import { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import {
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
import ScreenHeader from '@/components/navigation/ScreenHeader';
import { useKycStatus, useMe, useSubmitKyc } from '@/hooks/useExchange';
import type { TierInfo } from '@/services/v2/types';

/** What each document is called, and what it looks like. */
const DOCUMENT: Record<string, { label: string; hint: string; keyboard: 'number-pad' }> = {
  bvn: {
    label: 'Bank Verification Number',
    hint: 'The 11-digit number you get by dialling *565*0#',
    keyboard: 'number-pad',
  },
  nin: {
    label: 'National Identity Number',
    hint: 'The 11-digit number on your NIN slip',
    keyboard: 'number-pad',
  },
};

export default function KycScreen() {
  const router = useRouter();
  const { c, space, radius } = useTheme();
  const { show } = useToast();

  const status = useKycStatus();
  const me = useMe();
  const submit = useSubmitKyc();

  const [idNumber, setIdNumber] = useState('');
  const [error, setError] = useState('');

  // Name and date of birth live on the profile. Collecting them again at the
  // moment someone is already handing over a BVN turns verification into an
  // interrogation, so this screen asks for the one thing the profile cannot
  // hold: the identity number itself.
  const profileComplete = me.data?.profileComplete ?? false;

  const requirement = status.data?.nextRequirement ?? null;
  const document = requirement ? DOCUMENT[requirement] : undefined;

  const canSubmit =
    !!document && profileComplete && idNumber.replace(/\D/g, '').length === 11;

  const send = useCallback(async () => {
    setError('');
    try {
      // Name and date of birth are omitted deliberately — the server reads them
      // from the profile, which is the single place they are edited.
      const result = await submit.mutateAsync({ idNumber: idNumber.replace(/\D/g, '') });
      show(result.message, result.status === 'approved' ? 'positive' : 'neutral');
      setIdNumber('');
    } catch (err) {
      setError((err as { message?: string })?.message ?? 'Could not verify those details.');
    }
  }, [submit, idNumber, show]);

  const ladder = useMemo(() => status.data?.tiers ?? [], [status.data]);
  const currentTier = status.data?.tier ?? 0;
  const pending = status.data?.pending;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Screen edges={['top']}>
        <ScreenHeader title="Verification" onBack={() => router.back()} />

        {status.isLoading ? (
          <View style={{ gap: space.base, marginTop: space.base }}>
            <Skeleton width="100%" height={92} radius={radius.card} />
            <Skeleton width="100%" height={220} radius={radius.card} />
          </View>
        ) : (
          <>
            {/* What you have now. */}
            <Stagger index={0}>
              <Surface level={1} style={{ gap: space.snug, marginTop: space.base }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
                  <Ionicons
                    name={status.data?.canWithdraw ? 'shield-checkmark' : 'shield-outline'}
                    size={17}
                    color={status.data?.canWithdraw ? c.positive : c.warning}
                  />
                  <Text variant="eyebrow" color="tertiaryText">
                    {ladder.find((t) => t.tier === currentTier)?.name ?? 'Unverified'} · Tier{' '}
                    {currentTier}
                  </Text>
                </View>

                {status.data?.canWithdraw ? (
                  <>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.snug }}>
                      <Money value={Number(status.data.dailyLimitNgn)} variant="figure" whole />
                      <Text variant="bodySmall" color="secondaryText">
                        a day
                      </Text>
                    </View>
                    <Text variant="caption" color="tertiaryText">
                      This is how much you can send to your bank in 24 hours.
                    </Text>
                  </>
                ) : (
                  <>
                    <Text variant="heading">You can’t withdraw yet</Text>
                    <Text variant="bodySmall" color="secondaryText">
                      Deposits and gift cards work without verification. Sending naira to a bank
                      account needs it.
                    </Text>
                  </>
                )}
              </Surface>
            </Stagger>

            {/* Where you can get to. */}
            <Stagger index={1}>
              <Section title="Limits by tier">
                <Surface level={1} padding={0} style={{ paddingHorizontal: space.comfy }}>
                  {ladder.map((tier, i) => (
                    <TierRow
                      key={tier.tier}
                      tier={tier}
                      current={tier.tier === currentTier}
                      reached={tier.tier <= currentTier}
                      last={i === ladder.length - 1}
                    />
                  ))}
                </Surface>
              </Section>
            </Stagger>

            {/* Then, and only then, the form. */}
            {pending ? (
              <Stagger index={2}>
                <Surface
                  level={1}
                  accentEdge={pending.status === 'rejected' ? c.negative : c.warning}
                  style={{ marginTop: space.section, flexDirection: 'row', gap: space.base }}
                >
                  <Ionicons
                    name={pending.status === 'rejected' ? 'close-circle' : 'hourglass-outline'}
                    size={19}
                    color={pending.status === 'rejected' ? c.negative : c.warning}
                  />
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text variant="subheading">
                      {pending.status === 'rejected'
                        ? 'We couldn’t verify those details'
                        : 'We’re checking your details'}
                    </Text>
                    <Text variant="bodySmall" color="secondaryText">
                      {pending.rejectionReason ??
                        'This usually takes a few minutes. We’ll notify you either way.'}
                    </Text>
                  </View>
                </Surface>
              </Stagger>
            ) : document ? (
              <Stagger index={2}>
                <Section title={`Add your ${requirement?.toUpperCase()}`}>
                  {profileComplete ? (
                    <Input
                      label={document.label}
                      value={idNumber}
                      onChangeText={(t) => setIdNumber(t.replace(/\D/g, '').slice(0, 11))}
                      placeholder="12345678901"
                      keyboardType={document.keyboard}
                      maxLength={11}
                      mono
                      hint={document.hint}
                    />
                  ) : (
                    // Blocked rather than duplicating the fields here. Two places
                    // to set a name is how they drift apart, and the one that
                    // matters at payout is the profile.
                    <Surface
                      level={1}
                      accentEdge={c.warning}
                      style={{ flexDirection: 'row', gap: space.base, marginBottom: space.comfy }}
                    >
                      <Ionicons name="person-outline" size={19} color={c.warning} />
                      <View style={{ flex: 1, gap: space.snug }}>
                        <Text variant="subheading">Complete your profile first</Text>
                        <Text variant="bodySmall" color="secondaryText">
                          We need your full name and date of birth before we can verify you. Add
                          them once and this becomes a single field.
                        </Text>
                        <Button
                          title="Go to profile"
                          variant="secondary"
                          size="sm"
                          onPress={() => router.push('/(tabs)/(main)/profile')}
                          style={{ alignSelf: 'flex-start' }}
                        />
                      </View>
                    </Surface>
                  )}

                  {error ? (
                    <Surface
                      level={1}
                      accentEdge={c.negative}
                      style={{ flexDirection: 'row', gap: space.snug, marginBottom: space.base }}
                    >
                      <Ionicons name="alert-circle" size={17} color={c.negative} />
                      <Text variant="bodySmall" color="negative" style={{ flex: 1 }}>
                        {error}
                      </Text>
                    </Surface>
                  ) : null}

                  {profileComplete ? (
                    <Text
                      variant="caption"
                      color="tertiaryText"
                      style={{ marginBottom: space.comfy }}
                    >
                      Verifying as {me.data?.displayName} · {me.data?.dateOfBirth}
                    </Text>
                  ) : null}

                  <Button
                    title="Verify me"
                    onPress={send}
                    disabled={!canSubmit}
                    loading={submit.isPending}
                    haptic="medium"
                    size="lg"
                    fullWidth
                  />

                  {/* Said plainly, because handing over a BVN is a real ask and
                      a vague reassurance reads worse than none. */}
                  <View
                    style={{
                      flexDirection: 'row',
                      gap: space.snug,
                      marginTop: space.comfy,
                      paddingHorizontal: space.tight,
                    }}
                  >
                    <Ionicons name="lock-closed-outline" size={13} color={c.tertiaryText} />
                    <Text variant="caption" color="tertiaryText" style={{ flex: 1 }}>
                      Your number goes to the verification service and is never stored here — we
                      keep only the last four digits to show you which ID you used.
                    </Text>
                  </View>
                </Section>
              </Stagger>
            ) : (
              <Stagger index={2}>
                <Surface
                  level={1}
                  style={{
                    marginTop: space.section,
                    alignItems: 'center',
                    gap: space.snug,
                  }}
                >
                  <Ionicons name="shield-checkmark" size={26} color={c.positive} />
                  <Text variant="subheading">You’re fully verified</Text>
                  <Text variant="bodySmall" color="tertiaryText" align="center">
                    You have the highest limit available.
                  </Text>
                </Surface>
              </Stagger>
            )}
          </>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}

/**
 * One rung. Reached tiers are ticked, the current one is marked, and the limit
 * is stated in naira rather than as a tier number — "₦500,000 a day" is the
 * thing the user is actually choosing between.
 */
function TierRow({
  tier,
  current,
  reached,
  last,
}: {
  tier: TierInfo;
  current: boolean;
  reached: boolean;
  last: boolean;
}) {
  const { c, space } = useTheme();
  const limit = Number(tier.dailyLimitNgn);

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
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: reached ? c.positiveDim : 'transparent',
          borderWidth: reached ? 0 : 1.5,
          borderColor: c.border,
        }}
      >
        {reached ? <Ionicons name="checkmark" size={13} color={c.positive} /> : null}
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.snug }}>
          <Text variant="subheading" color={reached ? 'primaryText' : 'secondaryText'}>
            {tier.name}
          </Text>
          {current ? (
            <Text variant="eyebrow" color="primaryAccent" style={{ fontSize: 9 }}>
              You
            </Text>
          ) : null}
        </View>
        <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }} numberOfLines={1}>
          {tier.requirement}
        </Text>
      </View>

      {limit > 0 ? (
        <Money
          value={limit}
          variant="amountSmall"
          whole
          color={reached ? 'primaryText' : 'tertiaryText'}
        />
      ) : (
        <Text variant="amountSmall" color="tertiaryText">
          —
        </Text>
      )}
    </View>
  );
}
