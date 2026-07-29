/**
 * Passwordless auth against the v2 (Rust) core.
 *
 * There is no separate "register" and "login" here, because in this model there
 * is no difference: the same Google tap or the same phone number either finds an
 * account or creates one. The server decides which, the client does not care.
 *
 * See docs/ARCHITECTURE.md §10.
 */

import axios, { isAxiosError } from 'axios';
import { config } from '@/constants/config';
import type { User } from '@/store/authStore';

const API = `${config.apiUrl}/v2`;
const TIMEOUT_MS = 15000;

export interface AuthSession {
  token: string;
  refreshToken: string;
  user: User;
  /** True when this call created the account, so we can show the PIN setup. */
  isNewAccount: boolean;
}

interface RawSession {
  token: string;
  refreshToken: string;
  isNewAccount: boolean;
  user: {
    id: string;
    displayName?: string | null;
    email?: string | null;
    phone?: string | null;
    kycTier?: number;
    role?: string;
  };
}

function toSession(raw: RawSession): AuthSession {
  return {
    token: raw.token,
    refreshToken: raw.refreshToken,
    isNewAccount: raw.isNewAccount,
    user: {
      _id: raw.user.id,
      name: raw.user.displayName ?? '',
      email: raw.user.email ?? '',
      phone: raw.user.phone ?? undefined,
      kycTier: raw.user.kycTier ?? 0,
      role: raw.user.role as 'user' | 'admin' | undefined,
    },
  };
}

const client = axios.create({ baseURL: API, timeout: TIMEOUT_MS });

/** Normalise a Nigerian number to E.164. Mirrors `normalize_ng_phone` in Rust. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  let national: string;
  if (digits.length === 11 && digits.startsWith('0')) national = digits.slice(1);
  else if (digits.length === 13 && digits.startsWith('234')) national = digits.slice(3);
  else if (digits.length === 10) national = digits;
  else return null;

  if (!/^[789]/.test(national)) return null;
  return `+234${national}`;
}

/** Ask for an SMS code. Returns the number it was sent to, already normalised. */
export async function requestOtp(phoneInput: string): Promise<string> {
  const phone = normalizePhone(phoneInput);
  if (!phone) throw new AuthError('Enter a valid Nigerian phone number');

  try {
    await client.post('/auth/otp/request', { phone });
    return phone;
  } catch (err) {
    throw toAuthError(err);
  }
}

export async function verifyOtp(phone: string, code: string): Promise<AuthSession> {
  try {
    const { data } = await client.post<RawSession>('/auth/otp/verify', { phone, code });
    return toSession(data);
  } catch (err) {
    throw toAuthError(err);
  }
}

/** Exchange a Google or Apple ID token for a session. */
export async function signInWithIdToken(
  provider: 'google' | 'apple',
  idToken: string,
  // Apple returns the name only on first authorization; forward it when present.
  fullName?: string,
): Promise<AuthSession> {
  try {
    const { data } = await client.post<RawSession>(`/auth/oidc/${provider}`, {
      idToken,
      fullName,
    });
    return toSession(data);
  } catch (err) {
    throw toAuthError(err);
  }
}

export async function setPin(token: string, pin: string): Promise<void> {
  try {
    await client.post(
      '/auth/pin',
      { pin },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    throw toAuthError(err);
  }
}

export class AuthError extends Error {
  /** True when the server was unreachable, as opposed to rejecting us. */
  readonly offline: boolean;

  constructor(message: string, offline = false) {
    super(message);
    this.name = 'AuthError';
    this.offline = offline;
  }
}

function toAuthError(err: unknown): AuthError {
  if (isAxiosError(err)) {
    const serverMessage = (err.response?.data as { message?: string } | undefined)?.message;
    if (serverMessage) return new AuthError(serverMessage);

    const offline =
      !err.response ||
      err.code === 'ECONNABORTED' ||
      err.code === 'ERR_NETWORK';
    if (offline) {
      return new AuthError("Can't reach Naivolt right now. Check your connection.", true);
    }
    return new AuthError('Something went wrong. Please try again.');
  }
  return new AuthError('Something went wrong. Please try again.');
}
