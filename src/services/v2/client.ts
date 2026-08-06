/**
 * HTTP implementation of the v2 service.
 *
 * Endpoints and payloads are specified in docs/API-CONTRACT.md. Until the Rust
 * services expose them this module compiles but its calls will 404 — which is
 * why `features.useMockExchange` defaults on.
 */

import { isAxiosError } from 'axios';
import { api } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
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
  if (isAxiosError(err)) {
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

  getGiftCardBrands: () => get('/gift-cards/brands'),

  /**
   * Multipart, because of the card photo.
   *
   * Uses XHR rather than axios or fetch: React Native's multipart handling drops
   * the file body on some Android builds, and this is the one request in the app
   * that carries a binary. Carried over from the v1 implementation, which hit the
   * same problem.
   */
  submitGiftCard: ({
    brandId,
    countryCode,
    faceValue,
    cardCode,
    cardPin,
    imageUri,
    idempotencyKey,
  }) =>
    new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('brandId', brandId);
      form.append('countryCode', countryCode);
      form.append('faceValue', faceValue);
      form.append('cardCode', cardCode);
      if (cardPin) form.append('cardPin', cardPin);

      if (imageUri) {
        const filename = imageUri.split('/').pop() || 'card.jpg';
        const match = /\.(jpe?g|png|webp)$/i.exec(filename);
        const mime = match ? `image/${match[1].toLowerCase().replace('jpg', 'jpeg')}` : 'image/jpeg';
        form.append('cardImage', { uri: imageUri, name: filename, type: mime } as unknown as Blob);
      }

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${api.defaults.baseURL}/gift-cards/submissions`);

      const token = useAuthStore.getState().token;
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Idempotency-Key', idempotencyKey);
      // Content-Type is deliberately not set — the runtime has to add the
      // multipart boundary, and setting it manually breaks the body.

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject({ code: 'UNKNOWN', message: 'Unexpected response from the server.' });
          }
          return;
        }
        let body: { code?: string; message?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        reject({
          code: body.code ?? 'UNKNOWN',
          message: body.message ?? 'Could not submit the card. Try again.',
        });
      };
      xhr.onerror = () =>
        reject({
          code: 'NETWORK',
          message: 'Cannot reach Naivolt. Check your connection and try again.',
        });
      xhr.ontimeout = () =>
        reject({ code: 'NETWORK', message: 'That took too long. Try again.' });
      // Generous: this is uploading a photo over a Nigerian mobile connection.
      xhr.timeout = 60_000;
      xhr.send(form);
    }),

  registerPushToken: (input) => post('/devices/push-token', input).then(() => undefined),

  getActivity: (cursor) => get(`/activity${cursor ? `?cursor=${cursor}` : ''}`),

  getActivityDetail: (id) => get(`/activity/${id}`),
};
