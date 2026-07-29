/**
 * HTTP implementation of the v2 service.
 *
 * Endpoints and payloads are specified in docs/API-CONTRACT.md. Until the Rust
 * services expose them this module compiles but its calls will 404 — which is
 * why `features.useMockExchange` defaults on.
 */

import axios from 'axios';
import { api } from '@/services/api';
import type { ExchangeService } from './index';
import type { ApiError, ApiErrorCode } from './types';

/**
 * Normalises anything thrown by axios into an ApiError.
 *
 * The backend sends `{ code, message }` on handled failures. Everything else —
 * a timeout, a 502 from a proxy, a DNS failure — has no code, and the UI still
 * needs to branch, so it becomes NETWORK rather than surfacing an axios message
 * like "Request failed with status code 502" to a user.
 */
export function toApiError(err: unknown): ApiError {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as { code?: string; message?: string } | undefined;
    if (body?.code) {
      return {
        code: body.code as ApiErrorCode,
        message: body.message ?? 'Something went wrong.',
      };
    }
    if (!err.response) {
      return {
        code: 'NETWORK',
        message: 'Cannot reach Naivolt. Check your connection and try again.',
      };
    }
  }
  return { code: 'UNKNOWN', message: 'Something went wrong. Try again.' };
}

async function get<T>(path: string): Promise<T> {
  try {
    const res = await api.get<T>(path);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

async function post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  try {
    const res = await api.post<T>(path, body, headers ? { headers } : undefined);
    return res.data;
  } catch (err) {
    throw toApiError(err);
  }
}

export const httpExchange: ExchangeService = {
  getPortfolio: () => get('/portfolio'),

  getRates: () => get('/rates'),

  getDepositAddress: (asset, chain) =>
    get(`/wallets/deposit-address?asset=${asset}&chain=${chain}`),

  getPendingDeposits: () => get('/deposits?status=pending'),

  createQuote: (asset, amount) => post('/quotes', { asset, amount }),

  executeQuote: (quoteId) => post(`/quotes/${quoteId}/execute`),

  getBankAccounts: () => get('/bank-accounts'),

  getBanks: () => get('/banks'),

  resolveAccount: (bankCode, accountNumber) =>
    get(
      `/banks/resolve?bank_code=${encodeURIComponent(bankCode)}&account_number=${encodeURIComponent(
        accountNumber
      )}`
    ),

  addBankAccount: (input) => post('/bank-accounts', input),

  removeBankAccount: async (id) => {
    try {
      await api.delete(`/bank-accounts/${id}`);
    } catch (err) {
      throw toApiError(err);
    }
  },

  getLimits: () => get('/limits'),

  createPayout: ({ amountNgn, destination, pin, idempotencyKey }) =>
    post(
      '/payouts',
      { amountNgn, destination, pin },
      // Sent as a header so a retry of the same intent can never pay twice,
      // per ARCHITECTURE.md §8.3.
      { 'Idempotency-Key': idempotencyKey }
    ),

  getActivity: (cursor) => get(`/activity${cursor ? `?cursor=${cursor}` : ''}`),
};
