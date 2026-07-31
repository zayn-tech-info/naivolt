/**
 * Query hooks over the v2 service.
 *
 * Cache policy is set per resource by how fast the underlying truth moves —
 * one global staleTime would either serve stale balances or hammer the API for
 * bank accounts that change monthly.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { exchange } from '@/services/v2';
import type { ApiError, Asset, Chain, PayoutDestination } from '@/services/v2/types';

export const exchangeKeys = {
  portfolio: ['v2', 'portfolio'] as const,
  rates: ['v2', 'rates'] as const,
  activity: ['v2', 'activity'] as const,
  limits: ['v2', 'limits'] as const,
  banks: ['v2', 'bank-accounts'] as const,
  banks_list: ['v2', 'banks'] as const,
  giftCardBrands: ['v2', 'gift-card-brands'] as const,
  deposits: ['v2', 'deposits', 'pending'] as const,
  depositAddress: (asset: Asset, chain: Chain) =>
    ['v2', 'deposit-address', asset, chain] as const,
};

export function usePortfolio() {
  return useQuery({
    queryKey: exchangeKeys.portfolio,
    queryFn: () => exchange.getPortfolio(),
    // Balances move when a deposit credits or a sale settles, both of which can
    // happen while the user is looking at the screen.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/**
 * The rates board. Polls faster than the portfolio because a rate a user is
 * watching is expected to move; a balance is not.
 */
export function useRates() {
  return useQuery({
    queryKey: exchangeKeys.rates,
    queryFn: () => exchange.getRates(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function useActivity() {
  return useQuery({
    queryKey: exchangeKeys.activity,
    queryFn: () => exchange.getActivity(),
    staleTime: 20_000,
  });
}

export function usePendingDeposits() {
  return useQuery({
    queryKey: exchangeKeys.deposits,
    queryFn: () => exchange.getPendingDeposits(),
    // Confirmations tick on-chain; this is the one thing worth polling hard,
    // and only while a deposit is actually in flight.
    refetchInterval: (query) => (query.state.data?.length ? 6_000 : false),
  });
}

export function useDepositAddress(asset: Asset, chain: Chain, enabled = true) {
  return useQuery({
    queryKey: exchangeKeys.depositAddress(asset, chain),
    queryFn: () => exchange.getDepositAddress(asset, chain),
    enabled,
    // Addresses are permanent and derived — no reason to refetch.
    staleTime: Infinity,
  });
}

export function useBankAccounts() {
  return useQuery({
    queryKey: exchangeKeys.banks,
    queryFn: () => exchange.getBankAccounts(),
    staleTime: 5 * 60_000,
  });
}

export function useBanks() {
  return useQuery({
    queryKey: exchangeKeys.banks_list,
    queryFn: () => exchange.getBanks(),
    // The institution list changes a few times a year at most.
    staleTime: 24 * 60 * 60_000,
  });
}

/**
 * Name enquiry, run as a query keyed on the bank/account pair.
 *
 * A query rather than a mutation because the result is a pure function of its
 * inputs and caching it matters: users retype and correct account numbers
 * constantly, and re-hitting the provider for a pair we already resolved is both
 * slow and billed per call.
 *
 * Only fires on a complete 10-digit number with a bank chosen — every partial
 * number would otherwise be a guaranteed-failing request.
 */
export function useResolveAccount(bankCode: string | null, accountNumber: string) {
  const digits = accountNumber.replace(/\D/g, '');
  const ready = !!bankCode && digits.length === 10;

  return useQuery({
    queryKey: ['v2', 'resolve-account', bankCode, digits] as const,
    queryFn: () => exchange.resolveAccount(bankCode!, digits),
    enabled: ready,
    retry: false,
    staleTime: 10 * 60_000,
  });
}

export function useAddBankAccount() {
  const qc = useQueryClient();
  return useMutation<
    Awaited<ReturnType<typeof exchange.addBankAccount>>,
    ApiError,
    { bankCode: string; accountNumber: string; accountName: string; nickname?: string }
  >({
    mutationFn: (input) => exchange.addBankAccount(input),
    retry: false,
    onSuccess: () => qc.invalidateQueries({ queryKey: exchangeKeys.banks }),
  });
}

export function useRemoveBankAccount() {
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => exchange.removeBankAccount(id),
    retry: false,
    onSuccess: () => qc.invalidateQueries({ queryKey: exchangeKeys.banks }),
  });
}

export function useGiftCardBrands() {
  return useQuery({
    queryKey: exchangeKeys.giftCardBrands,
    queryFn: () => exchange.getGiftCardBrands(),
    // Brands and their rates change on a business cadence, not a market one.
    staleTime: 10 * 60_000,
  });
}

export function useSubmitGiftCard() {
  const qc = useQueryClient();
  return useMutation<
    Awaited<ReturnType<typeof exchange.submitGiftCard>>,
    ApiError,
    {
      brandId: string;
      countryCode: string;
      faceValue: string;
      cardCode: string;
      cardPin?: string;
      imageUri?: string;
      idempotencyKey: string;
    }
  >({
    mutationFn: (input) => exchange.submitGiftCard(input),
    // Never auto-retry: the card code is single-use, and a blind retry after an
    // ambiguous failure risks submitting the same card twice. The idempotency key
    // makes a *deliberate* retry safe, which is the user's call, not ours.
    retry: false,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: exchangeKeys.activity });
    },
  });
}

export function useLimits() {
  return useQuery({
    queryKey: exchangeKeys.limits,
    queryFn: () => exchange.getLimits(),
    staleTime: 60_000,
  });
}

/**
 * Quotes are a mutation, not a query: each call issues a new server-side row
 * with its own expiry, so caching or deduping one would hand the user a rate
 * that has already run out.
 */
export function useCreateQuote() {
  return useMutation<Awaited<ReturnType<typeof exchange.createQuote>>, ApiError, { asset: Asset; amount: string }>({
    mutationFn: ({ asset, amount }) => exchange.createQuote(asset, amount),
    retry: false,
  });
}

export function useExecuteQuote() {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof exchange.executeQuote>>, ApiError, string>({
    mutationFn: (quoteId) => exchange.executeQuote(quoteId),
    // Never retry: the quote is consumed atomically server-side, and a blind
    // retry after an ambiguous failure risks selling twice.
    retry: false,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: exchangeKeys.portfolio });
      qc.invalidateQueries({ queryKey: exchangeKeys.activity });
    },
  });
}

export function useCreatePayout() {
  const qc = useQueryClient();
  return useMutation<
    Awaited<ReturnType<typeof exchange.createPayout>>,
    ApiError,
    { amountNgn: string; destination: PayoutDestination; pin: string; idempotencyKey: string }
  >({
    mutationFn: (input) => exchange.createPayout(input),
    retry: false,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: exchangeKeys.portfolio });
      qc.invalidateQueries({ queryKey: exchangeKeys.activity });
      qc.invalidateQueries({ queryKey: exchangeKeys.limits });
    },
  });
}
