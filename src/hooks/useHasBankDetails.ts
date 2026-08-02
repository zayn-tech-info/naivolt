/**
 * Whether the user has somewhere to be paid.
 *
 * Reads the v2 beneficiary list rather than the deleted v1 `/bank-accounts`
 * endpoint, and shares `useBankAccounts`' query key so the two can't disagree —
 * adding an account anywhere in the app updates this immediately.
 */

import { useBankAccounts } from './useExchange';

export function useHasBankDetails() {
  const { data = [], isLoading } = useBankAccounts();
  return { hasBankDetails: data.length > 0, isLoading };
}
