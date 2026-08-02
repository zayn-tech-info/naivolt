/**
 * Guards the withdraw flow on having a bank account.
 *
 * Replaces `useConvertGuard`, which guarded a Convert screen that no longer
 * exists and used `Alert.alert` to do it. Two changes:
 *
 *  - It routes rather than interrogates. A user with no bank account who taps
 *    Withdraw is sent to add one, with a toast saying why. The old dialog asked
 *    them to make a decision ("Not now" / "Add bank account") about a step they
 *    have to complete anyway — a question with only one real answer isn't a
 *    question.
 *  - No blocking OS modal. Alerts are for destructive confirmations; this is
 *    navigation.
 */

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useToast } from '@/components/ui';
import { useHasBankDetails } from './useHasBankDetails';

export function usePayoutGuard() {
  const router = useRouter();
  const { show } = useToast();
  const { hasBankDetails, isLoading } = useHasBankDetails();

  const navigateToWithdraw = useCallback(() => {
    // Still loading: do nothing rather than guess. Guessing wrong sends someone
    // to add an account they already have.
    if (isLoading) return;

    if (!hasBankDetails) {
      show('Add a bank account to receive your naira', 'warning');
      router.push('/bank-details');
      return;
    }
    router.push('/withdraw');
  }, [hasBankDetails, isLoading, router, show]);

  return { navigateToWithdraw, hasBankDetails, isLoading };
}
