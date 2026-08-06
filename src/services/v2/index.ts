/**
 * The v2 service boundary.
 *
 * Screens depend on this interface, not on axios. That's what lets the new
 * surfaces be built and reviewed now, against `mockExchange`, and switched to
 * the Rust API by flipping one flag once those endpoints exist — with no screen
 * changes, because the shapes were agreed up front in ./types.ts.
 *
 * See docs/API-CONTRACT.md for the wire format each method expects.
 */

import { features } from '@/constants/features';
import type {
  ActivityDetail,
  ActivityItem,
  Asset,
  Bank,
  BankAccount,
  Chain,
  Deposit,
  DepositAddress,
  GiftCardBrand,
  GiftCardSubmission,
  Limits,
  Payout,
  PayoutDestination,
  Portfolio,
  Quote,
  RateBoard,
  ResolvedAccount,
} from './types';
import { mockExchange } from './mock';
import { httpExchange } from './client';

export interface ExchangeService {
  // Balances
  getPortfolio(): Promise<Portfolio>;

  /**
   * Rates board. Carries the headline naira-per-dollar rate plus every asset we
   * price — not only the ones the user holds.
   */
  getRates(): Promise<RateBoard>;

  // Deposits
  getDepositAddress(asset: Asset, chain: Chain): Promise<DepositAddress>;
  getPendingDeposits(): Promise<Deposit[]>;

  // Selling
  /** Locks a rate. The returned quote expires — see Quote.expiresAt. */
  createQuote(asset: Asset, amount: string): Promise<Quote>;
  /** Consumes the quote. Idempotent on the quote id. */
  executeQuote(quoteId: string): Promise<ActivityItem>;

  // Payouts
  /** Saved beneficiaries, most recently paid first. */
  getBankAccounts(): Promise<BankAccount[]>;
  /** The payout provider's institution list, for the one-off destination flow. */
  getBanks(): Promise<Bank[]>;
  /**
   * Name enquiry. Returns the account holder's real name so the user can confirm
   * they're paying who they think they're paying — the only defence against a
   * mistyped digit sending money to a stranger.
   */
  resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount>;
  /** Saves a beneficiary independently of making a payout. */
  addBankAccount(input: {
    bankCode: string;
    accountNumber: string;
    accountName: string;
    nickname?: string;
  }): Promise<BankAccount>;
  removeBankAccount(id: string): Promise<void>;
  getLimits(): Promise<Limits>;
  /** PIN is required by the backend for every payout. */
  createPayout(input: {
    amountNgn: string;
    destination: PayoutDestination;
    pin: string;
    /** Client-generated UUID — the idempotency key. */
    idempotencyKey: string;
  }): Promise<Payout>;

  // Gift cards
  /** Brands we buy, with per-country rates. */
  getGiftCardBrands(): Promise<GiftCardBrand[]>;
  /**
   * Submits a card for review. Manual-review flow: this returns `pending`, and
   * naira is credited only on approval.
   */
  submitGiftCard(input: {
    brandId: string;
    countryCode: string;
    faceValue: string;
    cardCode: string;
    cardPin?: string;
    /** Local file URI of the card photo, uploaded as multipart. */
    imageUri?: string;
    /** Client-generated UUID, so a retry can't submit the same card twice. */
    idempotencyKey: string;
  }): Promise<GiftCardSubmission>;

  /**
   * Registers this installation for push.
   *
   * Keyed by deviceId so a user with two phones gets both, and signing out on
   * one drops only that one.
   */
  registerPushToken(input: { token: string; deviceId: string; platform: 'ios' | 'android' }): Promise<void>;

  // History
  getActivity(cursor?: string): Promise<{ items: ActivityItem[]; nextCursor: string | null }>;
  /** The receipt for one item — richer than the feed row. */
  getActivityDetail(id: string): Promise<ActivityDetail>;
}

/**
 * `useMockExchange` keeps the v2 screens renderable before the backend lands.
 * It must be off in any build that touches real money.
 */
export const exchange: ExchangeService = features.useMockExchange
  ? mockExchange
  : httpExchange;

export * from './types';
