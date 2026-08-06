/**
 * In-memory fixture for the v2 service.
 *
 * Exists so the new surfaces can be built and reviewed before the Rust backend
 * exposes them. It deliberately models the parts of the real system that change
 * how the UI must behave, rather than just returning happy-path shapes:
 *
 *  - quotes really expire, so the countdown and the re-quote path get exercised
 *  - deposits accumulate confirmations over time, so the progress UI is real
 *  - a wrong PIN and an over-limit payout both fail with their proper codes
 *  - every call has latency, so loading states are visible during development
 *
 * A fixture that only ever succeeds instantly hides exactly the states that
 * break in production.
 */

import type { ExchangeService } from './index';
import { MOCK_BANKS, fixtureAccountName } from './banks.mock';
import { getLiveRates, getSellRates } from './rates';
import { MOCK_GIFT_CARD_BRANDS } from './giftcards.mock';
import { netNgnPerUsd, ngnRateForUsdPrice } from '@/constants/pricing';
import type {
  ActivityDetail,
  ActivityItem,
  ApiError,
  Asset,
  RateBoard,
  Bank,
  BankAccount,
  Chain,
  Deposit,
  DepositAddress,
  GiftCardBrand,
  GiftCardSubmission,
  Limits,
  Payout,
  Portfolio,
  Quote,
  ResolvedAccount,
} from './types';

const LATENCY_MS = 420;

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function fail(error: ApiError, ms = LATENCY_MS): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(error), ms));
}

/**
 * Fallback **USD** prices, used only when CoinGecko is unreachable — offline dev,
 * or a rate-limited free tier. Rough, and deliberately so: they exist to keep the
 * UI renderable, not to price anything.
 *
 * Stored in USD rather than naira so they run through the same conversion as live
 * prices — otherwise changing the naira rate would move real rates but not these,
 * and the two would silently disagree.
 */
const FALLBACK_USD_PRICES: Partial<Record<Asset, number>> = {
  BTC: 64_000,
  ETH: 1_900,
  BNB: 570,
  SOL: 73,
  USDT: 1,
  USDC: 1,
  TRX: 0.325,
};

const CHAIN_NETWORK: Record<Chain, string> = {
  tron: 'TRC-20',
  ethereum: 'ERC-20',
  bsc: 'BEP-20',
  polygon: 'Polygon',
  base: 'Base',
  bitcoin: 'Bitcoin',
  solana: 'Solana',
};

const CONFIRMATIONS: Record<Chain, number> = {
  bitcoin: 2,
  ethereum: 12,
  bsc: 20,
  polygon: 20,
  base: 10,
  tron: 20,
  solana: 1,
};

/** Mutable fixture state, so actions taken in the app persist for the session. */
const state = {
  holdings: [
    { asset: 'USDT' as Asset, balance: '248.415000' },
    { asset: 'BTC' as Asset, balance: '0.00412000' },
    { asset: 'SOL' as Asset, balance: '3.20000000' },
  ],
  ngnBalance: '84250.0000',
  activity: [
    {
      id: 'a1',
      kind: 'giftcard' as const,
      asset: 'NGN' as Asset,
      amount: '148000.0000',
      ngnValue: '148000.0000',
      status: 'completed' as const,
      createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      detail: 'Amazon $100 · US',
    },
    {
      id: 'a2',
      kind: 'payout' as const,
      asset: 'NGN' as Asset,
      amount: '150000.0000',
      ngnValue: '150000.0000',
      status: 'settled' as const,
      createdAt: new Date(Date.now() - 3 * 3600_000 + 120_000).toISOString(),
      detail: 'GTBank ···4821',
    },
    {
      id: 'a3',
      kind: 'deposit' as const,
      asset: 'USDT' as Asset,
      amount: '248.415000',
      ngnValue: '380074.9500',
      status: 'credited' as const,
      createdAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      detail: 'TRC-20 · 20 confirmations',
    },
    {
      id: 'a4',
      kind: 'deposit' as const,
      asset: 'BTC' as Asset,
      amount: '0.00412000',
      ngnValue: '405614.0000',
      status: 'credited' as const,
      createdAt: new Date(Date.now() - 4 * 86400_000).toISOString(),
      detail: 'Bitcoin · 2 confirmations',
    },
  ] as ActivityItem[],
  quotes: new Map<string, Quote>(),
  /** Keyed by idempotency key, so a replayed submit returns the same record. */
  giftCardSubmissions: new Map<string, GiftCardSubmission>(),
  /** A deposit mid-confirmation, so the tracker has something to show. */
  depositStartedAt: Date.now() - 45_000,

  /** Beneficiaries. Mutable, so saving one persists for the session. */
  beneficiaries: [
    {
      id: 'b1',
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: '0123454821',
      accountName: 'ADEYEMI DIVINE',
      verifiedAt: new Date(Date.now() - 12 * 86400_000).toISOString(),
      lastUsedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      nickname: null,
    },
    {
      id: 'b2',
      bankCode: '033',
      bankName: 'UBA',
      accountNumber: '2087651093',
      accountName: 'ADEYEMI DIVINE',
      verifiedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
      lastUsedAt: null,
      nickname: 'Savings',
    },
    {
      id: 'b3',
      bankCode: '999992',
      bankName: 'OPay',
      accountNumber: '8123456789',
      accountName: 'CHINEDU OKAFOR',
      verifiedAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
      lastUsedAt: new Date(Date.now() - 9 * 86400_000).toISOString(),
      nickname: 'Chinedu',
    },
  ] as BankAccount[],
};

/** Fallback naira rates, derived through the same conversion as live prices. */
function fallbackNgnRates(): Partial<Record<Asset, number>> {
  return (Object.keys(FALLBACK_USD_PRICES) as Asset[]).reduce<Partial<Record<Asset, number>>>(
    (acc, asset) => {
      acc[asset] = ngnRateForUsdPrice(FALLBACK_USD_PRICES[asset] ?? 0);
      return acc;
    },
    {}
  );
}

/**
 * Live net naira rates per unit, falling back to the table above when CoinGecko
 * can't be reached. Already post-spread — see services/v2/rates.ts.
 */
async function currentRates(): Promise<Partial<Record<Asset, number>>> {
  const fallback = fallbackNgnRates();
  try {
    const live = await getSellRates();
    // Merge so an asset CoinGecko didn't return still has something to show.
    return { ...fallback, ...live };
  } catch {
    return fallback;
  }
}

const QUOTE_WINDOW_SECONDS = 60;

/** Terminal states, for deciding whether a timeline's last step is reached. */
const SETTLED = new Set(['settled', 'credited', 'completed', 'approved']);
const FAILED = new Set(['failed', 'rejected', 'reversed', 'expired', 'cancelled']);

/**
 * Expands a feed row into a receipt.
 *
 * The timeline is the part worth getting right: a user opening a transaction
 * that hasn't landed wants to know *where* it is, not just that it's "pending".
 * Each kind has its own real sequence, so they're built separately rather than
 * forced through one generic three-step shape.
 */
function buildDetail(item: ActivityItem): ActivityDetail {
  const created = item.createdAt;
  const settled = SETTLED.has(item.status);
  const failed = FAILED.has(item.status);

  const base: ActivityDetail = {
    ...item,
    reference: `NV-${item.id.toUpperCase()}`,
  };

  if (item.kind === 'deposit') {
    const confirmations = settled ? 20 : 7;
    return {
      ...base,
      network: item.detail?.split(' · ')[0] ?? 'TRC-20',
      txHash: '9f2c1a7b3e8d4f5a6c0b2d1e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a',
      explorerUrl:
        'https://tronscan.org/#/transaction/9f2c1a7b3e8d4f5a6c0b2d1e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a',
      confirmations,
      minConfirmations: 20,
      timeline: [
        { label: 'Seen on-chain', at: created, state: 'done' },
        {
          label: `Confirming (${confirmations}/20)`,
          at: created,
          state: settled ? 'done' : 'current',
        },
        {
          label: 'Credited to your balance',
          at: settled ? created : null,
          state: settled ? 'done' : 'pending',
        },
      ],
    };
  }

  if (item.kind === 'payout') {
    return {
      ...base,
      bankName: item.detail?.split(' ···')[0] ?? 'Bank',
      accountNumber: `••••••${item.detail?.split('···')[1] ?? '0000'}`,
      accountName: 'ADEYEMI DIVINE',
      fee: '0.0000',
      timeline: [
        { label: 'Requested', at: created, state: 'done' },
        {
          label: failed ? 'Failed at the bank' : 'Sent to your bank',
          at: created,
          state: failed ? 'failed' : 'done',
        },
        {
          label: 'Settled',
          at: settled ? created : null,
          state: failed ? 'pending' : settled ? 'done' : 'current',
        },
      ],
      ...(failed ? { failureReason: 'Your bank rejected the transfer. Funds were returned.' } : null),
    };
  }

  if (item.kind === 'giftcard') {
    const [brand, country] = (item.detail ?? '').split(' · ');
    return {
      ...base,
      brandName: brand?.split(' ')[0] ?? 'Gift card',
      faceValue: brand?.match(/[\d.]+/)?.[0],
      currency: brand?.includes('$') ? 'USD' : undefined,
      ...(country ? { network: country } : null),
      timeline: [
        { label: 'Card submitted', at: created, state: 'done' },
        {
          label: failed ? 'Rejected' : 'Checked by our team',
          at: created,
          state: failed ? 'failed' : settled ? 'done' : 'current',
        },
        {
          label: 'Naira credited',
          at: settled ? created : null,
          state: failed ? 'pending' : settled ? 'done' : 'pending',
        },
      ],
      ...(failed
        ? { failureReason: 'The card balance could not be verified. Nothing was charged.' }
        : null),
    };
  }

  return base;
}

export const mockExchange: ExchangeService = {
  async getPortfolio(): Promise<Portfolio> {
    const rates = await currentRates();
    const rateFor = (asset: Asset) => rates[asset] ?? 0;

    const holdings = state.holdings.map((h) => ({
      asset: h.asset,
      balance: h.balance,
      ngnValue: (Number(h.balance) * rateFor(h.asset)).toFixed(4),
      rate: rateFor(h.asset).toFixed(4),
    }));

    const cryptoTotal = holdings.reduce((sum, h) => sum + Number(h.ngnValue), 0);

    return delay({
      totalNgn: (cryptoTotal + Number(state.ngnBalance)).toFixed(4),
      ngnBalance: state.ngnBalance,
      holdings,
      changePct24h: 2.4,
    });
  },

  async getRates(): Promise<RateBoard> {
    try {
      const live = await getLiveRates();
      return {
        ngnPerUsd: live.ngnPerUsd.toFixed(4),
        asOf: new Date(live.asOf).toISOString(),
        assets: live.assets.map((row) => ({
          asset: row.asset,
          usdPrice: row.usdPrice.toFixed(8),
          rate: row.rate.toFixed(4),
          changePct24h: row.changePct24h,
        })),
      };
    } catch {
      // Offline: show the fallback table so the board isn't empty, but with no
      // 24h movement — inventing a change figure would be fabricating data.
      return {
        ngnPerUsd: netNgnPerUsd().toFixed(4),
        asOf: new Date().toISOString(),
        assets: (Object.keys(FALLBACK_USD_PRICES) as Asset[])
          .map((asset) => {
            const usd = FALLBACK_USD_PRICES[asset] ?? 0;
            return {
              asset,
              usdPrice: usd.toFixed(8),
              rate: ngnRateForUsdPrice(usd).toFixed(4),
              changePct24h: null,
            };
          })
          .sort((a, b) => Number(b.usdPrice) - Number(a.usdPrice)),
      };
    }
  },

  async getDepositAddress(asset: Asset, chain: Chain): Promise<DepositAddress> {
    // Shapes match the real derivation output per chain, so the address
    // rendering and grouping are exercised against realistic strings.
    const addresses: Partial<Record<Chain, string>> = {
      tron: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
      ethereum: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      bsc: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      polygon: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      base: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      bitcoin: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      solana: '7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK',
    };

    return delay({
      asset,
      chain,
      network: CHAIN_NETWORK[chain],
      address: addresses[chain] ?? addresses.tron!,
      minConfirmations: CONFIRMATIONS[chain],
      minimumDeposit: asset === 'BTC' ? '0.00010000' : '1.000000',
    });
  },

  async getPendingDeposits(): Promise<Deposit[]> {
    // Advance one confirmation every 6s from a fixed start, so the tracker
    // visibly progresses while someone is looking at the screen.
    const elapsed = (Date.now() - state.depositStartedAt) / 1000;
    const confirmations = Math.min(20, Math.floor(elapsed / 6));
    if (confirmations >= 20) return delay([]);

    return delay([
      {
        id: 'd1',
        asset: 'USDT',
        chain: 'tron',
        amount: '50.000000',
        txHash: '9f2c1a7b3e8d4f5a6c0b2d1e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a',
        confirmations,
        minConfirmations: 20,
        status: confirmations === 0 ? 'detected' : 'confirming',
        createdAt: new Date(state.depositStartedAt).toISOString(),
      },
    ]);
  },

  async createQuote(asset: Asset, amount: string): Promise<Quote> {
    const held = state.holdings.find((h) => h.asset === asset);
    if (!held || Number(amount) > Number(held.balance)) {
      return fail({
        code: 'INSUFFICIENT_BALANCE',
        message: `You don't have that much ${asset}.`,
      });
    }

    const rates = await currentRates();
    const rate = rates[asset] ?? 0;
    if (rate <= 0) {
      return fail({
        code: 'ASSET_PAUSED',
        message: `We can't price ${asset} right now. Try again shortly.`,
      });
    }

    const quote: Quote = {
      id: `q_${Math.floor(Date.now() / 1000)}_${asset}`,
      asset,
      amount,
      rate: rate.toFixed(4),
      ngnValue: (Number(amount) * rate).toFixed(4),
      expiresAt: new Date(Date.now() + QUOTE_WINDOW_SECONDS * 1000).toISOString(),
      windowSeconds: QUOTE_WINDOW_SECONDS,
    };
    state.quotes.set(quote.id, quote);
    return delay(quote, 300);
  },

  async executeQuote(quoteId: string): Promise<ActivityItem> {
    const quote = state.quotes.get(quoteId);
    if (!quote) {
      return fail({ code: 'QUOTE_CONSUMED', message: 'That rate has already been used.' });
    }
    if (Date.parse(quote.expiresAt) < Date.now()) {
      state.quotes.delete(quoteId);
      return fail({ code: 'QUOTE_EXPIRED', message: 'That rate expired. Get a new one.' });
    }

    state.quotes.delete(quoteId);

    // Move the fixture's ledger: crypto down, naira up.
    const held = state.holdings.find((h) => h.asset === quote.asset);
    if (held) held.balance = (Number(held.balance) - Number(quote.amount)).toFixed(6);
    state.ngnBalance = (Number(state.ngnBalance) + Number(quote.ngnValue)).toFixed(4);

    const item: ActivityItem = {
      id: `a_${Date.now()}`,
      kind: 'sell',
      asset: quote.asset,
      amount: quote.amount,
      ngnValue: quote.ngnValue,
      status: 'completed',
      createdAt: new Date().toISOString(),
      detail: `Sold at ₦${Number(quote.rate).toLocaleString('en-NG')}`,
    };
    state.activity.unshift(item);
    return delay(item, 600);
  },

  async getBankAccounts(): Promise<BankAccount[]> {
    // Most recently paid first, never-used last. Matches what the real endpoint
    // is asked to do in the contract, so the UI ordering is exercised here.
    const sorted = [...state.beneficiaries].sort((a, b) => {
      const at = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
      const bt = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
      return bt - at;
    });
    return delay(sorted);
  },

  async getBanks(): Promise<Bank[]> {
    return delay(MOCK_BANKS, 250);
  },

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolvedAccount> {
    const digits = accountNumber.replace(/\D/g, '');
    if (digits.length !== 10) {
      return fail({
        code: 'UNKNOWN',
        message: 'Account numbers are 10 digits.',
      });
    }
    // A number ending in 0 fails enquiry, so the not-found path is reachable in
    // development — this is the error users actually hit, from a typo.
    if (digits.endsWith('0') && digits !== '0123454821' && digits !== '2087651093') {
      return fail({
        code: 'UNKNOWN',
        message: 'Couldn’t find that account. Check the number and bank.',
      });
    }
    return delay(
      {
        accountName: fixtureAccountName(digits),
        bankCode,
        accountNumber: digits,
      },
      700 // name enquiry is a real network hop; don't make it feel instant
    );
  },

  async addBankAccount({ bankCode, accountNumber, accountName, nickname }): Promise<BankAccount> {
    const bank = MOCK_BANKS.find((b) => b.code === bankCode);
    const existing = state.beneficiaries.find(
      (b) => b.bankCode === bankCode && b.accountNumber === accountNumber
    );
    if (existing) return delay(existing, 300);

    const account: BankAccount = {
      id: `b_${state.beneficiaries.length + 1}_${accountNumber.slice(-4)}`,
      bankCode,
      bankName: bank?.name ?? 'Bank',
      accountNumber,
      accountName,
      verifiedAt: new Date().toISOString(),
      lastUsedAt: null,
      nickname: nickname ?? null,
    };
    state.beneficiaries.push(account);
    return delay(account, 400);
  },

  async removeBankAccount(id: string): Promise<void> {
    const index = state.beneficiaries.findIndex((b) => b.id === id);
    if (index >= 0) state.beneficiaries.splice(index, 1);
    return delay(undefined, 300);
  },

  async getLimits(): Promise<Limits> {
    return delay({
      kycTier: 2,
      dailyRemainingNgn: '850000.0000',
      dailyLimitNgn: '1000000.0000',
      perTransactionMaxNgn: '500000.0000',
      minWithdrawalNgn: '1000.0000',
    });
  },

  async createPayout({ amountNgn, destination, pin }): Promise<Payout> {
    // 123456 is the fixture's correct PIN; anything else exercises the shake.
    if (pin !== '123456') {
      return fail({ code: 'PIN_INVALID', message: 'That PIN is wrong. Try again.' });
    }
    if (Number(amountNgn) > Number(state.ngnBalance)) {
      return fail({ code: 'INSUFFICIENT_BALANCE', message: 'That is more than your naira balance.' });
    }
    if (Number(amountNgn) > 500_000) {
      return fail({
        code: 'LIMIT_EXCEEDED',
        message: 'Single transfers are capped at ₦500,000 on your tier.',
        meta: { limit: '500000' },
      });
    }

    // Resolve the destination to something displayable, and persist it if the
    // user asked to save it.
    let account: BankAccount;
    if (destination.kind === 'beneficiary') {
      const found = state.beneficiaries.find((b) => b.id === destination.bankAccountId);
      if (!found) {
        return fail({ code: 'UNKNOWN', message: 'That account is no longer saved.' });
      }
      account = found;
    } else {
      const bank = MOCK_BANKS.find((b) => b.code === destination.bankCode);
      account = {
        id: `oneoff_${destination.accountNumber}`,
        bankCode: destination.bankCode,
        bankName: bank?.name ?? 'Bank',
        accountNumber: destination.accountNumber,
        accountName: destination.accountName,
        verifiedAt: new Date().toISOString(),
        lastUsedAt: null,
        nickname: destination.nickname ?? null,
      };
      if (destination.save) {
        const saved = await mockExchange.addBankAccount({
          bankCode: destination.bankCode,
          accountNumber: destination.accountNumber,
          accountName: destination.accountName,
          nickname: destination.nickname,
        });
        account = saved;
      }
    }

    // Paying a beneficiary bumps it to the top of the list next time.
    const stored = state.beneficiaries.find((b) => b.id === account.id);
    if (stored) stored.lastUsedAt = new Date().toISOString();

    state.ngnBalance = (Number(state.ngnBalance) - Number(amountNgn)).toFixed(4);

    const payout: Payout = {
      id: `p_${Date.now()}`,
      amountNgn,
      fee: '10.0000',
      bankAccount: {
        bankName: account.bankName,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
      },
      status: 'processing',
      reference: `NVLT-${Math.floor(Date.now() / 1000)}`,
      createdAt: new Date().toISOString(),
      settledAt: null,
    };

    state.activity.unshift({
      id: payout.id,
      kind: 'payout',
      asset: 'NGN',
      amount: amountNgn,
      ngnValue: amountNgn,
      status: 'processing',
      createdAt: payout.createdAt,
      detail: `${account.bankName} ···${account.accountNumber.slice(-4)}`,
    });

    return delay(payout, 900);
  },

  async getGiftCardBrands(): Promise<GiftCardBrand[]> {
    return delay(MOCK_GIFT_CARD_BRANDS, 500);
  },

  async submitGiftCard({
    brandId,
    countryCode,
    faceValue,
    cardCode,
    imageUri,
    idempotencyKey,
  }): Promise<GiftCardSubmission> {
    // Replaying the same key returns the original submission rather than
    // creating a second one — the same guarantee the real endpoint must give.
    const prior = state.giftCardSubmissions.get(idempotencyKey);
    if (prior) return delay(prior, 300);

    const brand = MOCK_GIFT_CARD_BRANDS.find((b) => b.id === brandId);
    if (!brand) {
      return fail({ code: 'UNKNOWN', message: 'That card type is no longer available.' });
    }

    const rate = brand.rates.find((r) => r.countryCode === countryCode);
    if (!rate) {
      return fail({ code: 'UNKNOWN', message: `We don't buy ${brand.name} cards from there.` });
    }

    const value = Number(faceValue);
    if (!Number.isFinite(value) || value <= 0) {
      return fail({ code: 'UNKNOWN', message: 'Enter the value printed on the card.' });
    }
    if (value < Number(rate.minFaceValue)) {
      return fail({
        code: 'UNKNOWN',
        message: `Minimum for ${brand.name} ${rate.countryCode} is ${rate.currency} ${rate.minFaceValue}.`,
      });
    }
    if (value > Number(rate.maxFaceValue)) {
      return fail({
        code: 'UNKNOWN',
        message: `Maximum for ${brand.name} ${rate.countryCode} is ${rate.currency} ${rate.maxFaceValue}.`,
      });
    }
    if (brand.requiresImage && !imageUri) {
      return fail({ code: 'UNKNOWN', message: 'A photo of the card is required.' });
    }
    // A code of all zeros exercises the rejection path, which is the outcome a
    // real user hits often enough that the UI has to handle it.
    if (/^0+$/.test(cardCode.replace(/\D/g, '')) && cardCode.replace(/\D/g, '').length > 3) {
      return fail({
        code: 'UNKNOWN',
        message: 'That card code isn’t valid. Check it and try again.',
      });
    }

    const payoutNgn = value * Number(rate.ratePerUnit);
    const submission: GiftCardSubmission = {
      id: `gcs_${state.giftCardSubmissions.size + 1}`,
      brandName: brand.name,
      countryCode,
      faceValue: value.toFixed(2),
      currency: rate.currency,
      payoutNgn: payoutNgn.toFixed(4),
      status: 'pending',
      reference: `NVGC-${1_700_000 + state.giftCardSubmissions.size}`,
      createdAt: new Date().toISOString(),
    };

    state.giftCardSubmissions.set(idempotencyKey, submission);

    // Show up in Activity immediately as pending. Naira is not credited until
    // approval, so the balance deliberately does not move here.
    state.activity.unshift({
      id: submission.id,
      kind: 'giftcard',
      asset: 'NGN',
      amount: submission.payoutNgn,
      ngnValue: submission.payoutNgn,
      status: 'pending',
      createdAt: submission.createdAt,
      detail: `${brand.name} ${rate.currency} ${value} · ${countryCode}`,
    });

    return delay(submission, 900);
  },

  async registerPushToken(): Promise<void> {
    // Nothing to store — the fixture can't send push. Resolving rather than
    // throwing keeps the calling flow identical to production.
    return delay(undefined, 200);
  },

  async getActivity(): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
    return delay({ items: [...state.activity], nextCursor: null });
  },

  async getActivityDetail(id: string): Promise<ActivityDetail> {
    const item = state.activity.find((a) => a.id === id);
    if (!item) {
      return fail({ code: 'UNKNOWN', message: 'We can’t find that transaction.' });
    }
    return delay(buildDetail(item), 350);
  },
};
