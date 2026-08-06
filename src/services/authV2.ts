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

/**
 * A validated sign-in identifier.
 *
 * Mirrors `Identifier` in `crates/auth/src/identifier.rs`. Both sides must agree
 * on what counts as a phone versus an email: the client picks the keyboard and
 * the hint, the server picks SMS or mail. A disagreement is a code sent to the
 * wrong place and a user who cannot get in.
 */
export type Identifier =
  | { kind: 'phone'; value: string }
  | { kind: 'email'; value: string };

/** Normalise a Nigerian number to E.164. Mirrors `normalize_ng_phone`. */
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

/** Normalise an email. Mirrors `normalize_email` — no gmail alias collapsing. */
export function normalizeEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  const at = value.indexOf('@');
  if (at <= 0) return null;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || !domain) return null;
  if (domain.includes('@') || !domain.includes('.')) return null;
  if (domain.split('.').some((label) => label === '')) return null;
  if (/\s/.test(value)) return null;

  return value;
}

/**
 * Decide whether the user typed a phone number or an email.
 *
 * The `@` is checked first and deliberately: a string containing one is never a
 * phone number. Treating `0801...@gmail.com` as a phone because it starts with
 * digits would send an SMS into the void.
 */
export function parseIdentifier(input: string): Identifier | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.includes('@')) {
    const email = normalizeEmail(trimmed);
    return email ? { kind: 'email', value: email } : null;
  }

  const phone = normalizePhone(trimmed);
  return phone ? { kind: 'phone', value: phone } : null;
}

/** Partially mask an identifier for "we sent a code to …". */
export function maskIdentifier(id: Identifier): string {
  if (id.kind === 'phone') {
    return id.value.length === 14
      ? `${id.value.slice(0, 4)} ${id.value.slice(4, 7)} ••• ${id.value.slice(10)}`
      : id.value;
  }
  const at = id.value.indexOf('@');
  const local = id.value.slice(0, at);
  if (local.length <= 2) return id.value;
  return `${local.slice(0, 2)}${'•'.repeat(local.length - 2)}${id.value.slice(at)}`;
}

/**
 * Ask for a code. Returns the identifier it was sent to, already normalised.
 *
 * One endpoint for both channels — the server derives SMS or email from the
 * identifier, so the client never has to know which was chosen.
 */
export async function requestOtp(input: string): Promise<Identifier> {
  const identifier = parseIdentifier(input);
  if (!identifier) {
    throw new AuthError('Enter a valid phone number or email address');
  }

  try {
    await client.post('/auth/otp/request', { identifier: identifier.value });
    return identifier;
  } catch (err) {
    throw toAuthError(err);
  }
}

export async function verifyOtp(identifier: string, code: string): Promise<AuthSession> {
  try {
    const { data } = await client.post<RawSession>('/auth/otp/verify', {
      identifier,
      code,
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
