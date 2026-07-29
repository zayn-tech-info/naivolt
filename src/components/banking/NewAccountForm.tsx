/**
 * NewAccountForm — send to an account that isn't saved.
 *
 * The design centres on **name enquiry**, because that lookup is the only thing
 * standing between a mistyped digit and money landing with a stranger,
 * irreversibly. So:
 *
 *  - The resolved name gets its own panel, not a line of helper text. It's the
 *    thing the user must actually read before continuing.
 *  - Continuing is impossible until a name comes back. There is no "send anyway".
 *  - Enquiry fires automatically on the tenth digit rather than behind a "verify"
 *    button — a button there is a step users skip, and it makes the safety check
 *    feel optional.
 *  - The name is shown verbatim from the bank, in mono. Bank records are
 *    upper-case and oddly spaced; prettifying it would mean the user compares a
 *    cleaned-up version against what they expect instead of what the bank holds.
 *
 * The save-as-beneficiary toggle defaults **off**. Silently accumulating every
 * one-off destination turns the beneficiary list into a log, and this list is
 * what people scan when sending money in a hurry.
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/design';
import { Input, Surface, Text } from '@/components/ui';
import BankPicker, { bankInitials, bankTint } from './BankPicker';
import { useResolveAccount } from '@/hooks/useExchange';
import type { Bank } from '@/services/v2/types';

export interface NewAccountValue {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  save: boolean;
}

export interface NewAccountFormProps {
  /** Fires with a complete, name-verified destination, or null while incomplete. */
  onChange: (value: NewAccountValue | null) => void;
}

export function NewAccountForm({ onChange }: NewAccountFormProps) {
  const { c, space, radius } = useTheme();
  const [bank, setBank] = useState<Bank | null>(null);
  const [accountNumber, setAccountNumber] = useState('');
  const [save, setSave] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const digits = accountNumber.replace(/\D/g, '');
  const resolve = useResolveAccount(bank?.code ?? null, digits);
  const resolved = resolve.data;

  // Report upward only when the destination is complete and name-verified.
  useEffect(() => {
    if (bank && resolved) {
      onChange({
        bankCode: bank.code,
        bankName: bank.name,
        accountNumber: resolved.accountNumber,
        accountName: resolved.accountName,
        save,
      });
    } else {
      onChange(null);
    }
  }, [bank, resolved, save, onChange]);

  const handleNumber = useCallback((text: string) => {
    setAccountNumber(text.replace(/\D/g, '').slice(0, 10));
  }, []);

  const enquiryError =
    digits.length === 10 && bank && resolve.isError
      ? ((resolve.error as { message?: string })?.message ??
        'Couldn’t find that account. Check the number and bank.')
      : undefined;

  return (
    <View>
      <Text variant="label" color="secondaryText" style={{ marginBottom: space.snug }}>
        Bank
      </Text>
      <Surface
        level={1}
        radiusToken="field"
        onPress={() => setPickerOpen(true)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.base,
          marginBottom: space.comfy,
        }}
        accessibilityLabel={bank ? `Bank: ${bank.name}` : 'Select bank'}
      >
        {bank ? (
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 15,
              backgroundColor: `${bankTint(bank.name)}22`,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text variant="label" color={bankTint(bank.name)} style={{ fontSize: 11 }}>
              {bankInitials(bank.name)}
            </Text>
          </View>
        ) : (
          <Ionicons name="business-outline" size={18} color={c.tertiaryText} />
        )}

        <Text variant="body" color={bank ? 'primaryText' : 'quaternaryText'} style={{ flex: 1 }}>
          {bank?.name ?? 'Select bank'}
        </Text>
        <Ionicons name="chevron-forward" size={17} color={c.secondaryText} />
      </Surface>

      <Input
        label="Account number"
        value={accountNumber}
        onChangeText={handleNumber}
        placeholder="10 digits"
        keyboardType="number-pad"
        maxLength={10}
        mono
        editable={!!bank}
        hint={!bank ? 'Choose a bank first' : undefined}
        error={enquiryError}
      />

      {/* Name enquiry panel — the safety check, given its own weight. */}
      {bank && digits.length === 10 ? (
        <Surface
          level={1}
          radiusToken="field"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.base,
            borderWidth: 1,
            borderColor: resolved ? c.positive : resolve.isError ? c.negative : c.border,
          }}
        >
          {resolve.isFetching ? (
            <>
              <Ionicons name="sync-outline" size={17} color={c.secondaryText} />
              <Text variant="bodySmall" color="secondaryText">
                Checking account…
              </Text>
            </>
          ) : resolved ? (
            <>
              <Ionicons name="checkmark-circle" size={19} color={c.positive} />
              <View style={{ flex: 1 }}>
                <Text variant="eyebrow" color="tertiaryText">
                  Account name
                </Text>
                <Text variant="amount" style={{ marginTop: 3 }} numberOfLines={2}>
                  {resolved.accountName}
                </Text>
              </View>
            </>
          ) : (
            <>
              <Ionicons name="alert-circle" size={19} color={c.negative} />
              <Text variant="bodySmall" color="negative" style={{ flex: 1 }}>
                We couldn’t verify this account.
              </Text>
            </>
          )}
        </Surface>
      ) : null}

      {/* Save toggle appears only once there's something worth saving. */}
      {resolved ? (
        <Pressable
          onPress={() => setSave((v) => !v)}
          accessibilityRole="switch"
          accessibilityState={{ checked: save }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.base,
            marginTop: space.comfy,
            paddingVertical: space.snug,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text variant="subheading">Save as beneficiary</Text>
            <Text variant="caption" color="tertiaryText" style={{ marginTop: 2 }}>
              Skip the account number next time
            </Text>
          </View>
          <Switch
            value={save}
            onValueChange={setSave}
            trackColor={{ false: c.borderLight, true: c.primaryAccent }}
            thumbColor={save ? c.buttonTextOnAccent : c.surface}
          />
        </Pressable>
      ) : null}

      <BankPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={setBank}
        selectedCode={bank?.code}
      />
    </View>
  );
}

export default NewAccountForm;
