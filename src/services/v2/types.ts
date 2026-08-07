/**
 * v2 domain types.
 *
 * Mirrors the model in docs/ARCHITECTURE.md so the client and the Rust services
 * agree on shapes before either side is finished. Where that document names a
 * column, the field name here matches it.
 *
 * Money crosses the wire as a **decimal string**, never a JS number. The ledger
 * stores NUMERIC(38,18); IEEE-754 doubles cannot hold that without loss, and a
 * balance that rounds in transit is a bug that shows up as a customer dispute.
 * Components parse to a number only at the moment of display.
 */

/** Chains the platform custodies. */
export type Chain = 'tron' | 'ethereum' | 'bsc' | 'polygon' | 'base' | 'bitcoin' | 'solana';

/** Assets, as tickers. */
export type Asset = 'USDT' | 'USDC' | 'BTC' | 'ETH' | 'BNB' | 'SOL' | 'TRX' | 'NGN';

/** A decimal figure in string form. Parse only to render. */
export type Decimal = string;

export interface ChainMeta {
  chain: Chain;
  /** Display name for the network, e.g. "TRC-20". */
  network: string;
  label: string;
  /** Confirmations before a deposit is credited. */
  minConfirmations: number;
}

// ── Balances ────────────────────────────────────────────────────────

export interface Holding {
  asset: Asset;
  /** Ledger balance — what we owe the user. Never an on-chain read. */
  balance: Decimal;
  /** Value at the current sell rate, for display only. */
  ngnValue: Decimal;
  /** Rate used for ngnValue. */
  rate: Decimal;
}

export interface Portfolio {
  /**
   * Spendable naira. **The only field the UI renders.**
   *
   * Home shows this figure and Withdraw calls it "Available" — they are the same
   * number by design, so the app can never headline a balance larger than what a
   * user can actually send to their bank.
   */
  ngnBalance: Decimal;

  /**
   * Sum of crypto holdings plus `ngnBalance`.
   *
   * Not surfaced. Kept because it's meaningful to the ledger and to admin views,
   * but deliberately never rendered: a total that includes unconverted crypto
   * reads as withdrawable money and isn't.
   */
  totalNgn: Decimal;

  /**
   * Per-asset balances. Not surfaced — the app has no in-app path from a crypto
   * balance to naira, so listing coins would show a number the user can't act on.
   * Retained so the shape doesn't have to change if that path returns.
   */
  holdings: Holding[];

  /** Not surfaced. Naira doesn't move against naira, so there's nothing to show. */
  changePct24h: number | null;
}

/** One asset on the rates board. */
export interface AssetRate {
  asset: Asset;
  /** Market price in USD — the real deep-market number. */
  usdPrice: Decimal;
  /** Naira per unit, derived from usdPrice × the board's ngnPerUsd. */
  rate: Decimal;
  /** 24h move as a percentage. Null when unavailable. */
  changePct24h: number | null;
}

/**
 * The rates board.
 *
 * `ngnPerUsd` is the headline: what we pay per dollar of value, margin already
 * deducted. Every asset's naira rate is that number times its USD price, so one
 * figure drives the whole board and it's the one users ask for by name.
 *
 * There is deliberately **no mid rate and no spread field**. The app quotes one
 * number and pays exactly that number; our margin is embedded, not itemised. A
 * mid rate on this payload is a value some screen eventually renders by accident,
 * and it's visible to anyone watching the network regardless.
 */
export interface RateBoard {
  /** Net naira per US dollar. */
  ngnPerUsd: Decimal;
  assets: AssetRate[];
  /** When the underlying prices were sourced. */
  asOf: string;
}

// ── Deposits ────────────────────────────────────────────────────────

export interface DepositAddress {
  asset: Asset;
  chain: Chain;
  network: string;
  /** Permanent, derived from the user's address_index. Stable across sessions. */
  address: string;
  /** Some chains need a memo/tag; omitted where not applicable. */
  memo?: string;
  minConfirmations: number;
  /** Below this, a deposit won't be credited. */
  minimumDeposit: Decimal;
}

export type DepositStatus = 'detected' | 'confirming' | 'credited' | 'reversed';

export interface Deposit {
  id: string;
  asset: Asset;
  chain: Chain;
  amount: Decimal;
  txHash: string;
  confirmations: number;
  minConfirmations: number;
  status: DepositStatus;
  createdAt: string;
}

// ── Quotes and selling ──────────────────────────────────────────────

export interface Quote {
  id: string;
  asset: Asset;
  /** Crypto amount being sold. */
  amount: Decimal;
  /** Rate the user gets — mid minus spread. */
  rate: Decimal;
  /** Naira the user receives. */
  ngnValue: Decimal;
  /** ISO timestamp. The client must not let a sale be submitted past this. */
  expiresAt: string;
  /** Validity window, so the countdown can scale its bar. */
  windowSeconds: number;
}

// ── Payouts ─────────────────────────────────────────────────────────

/** An institution from the payout provider's list. */
export interface Bank {
  code: string;
  name: string;
  /** Fintechs and MMOs sit apart from commercial banks in most users' heads. */
  kind?: 'bank' | 'fintech' | 'microfinance';
}

/** A saved payout destination. */
export interface BankAccount {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  verifiedAt: string | null;
  /** Used to surface recent destinations first. Null if never paid out to. */
  lastUsedAt?: string | null;
  /** Optional user-given label, e.g. "Mum" or "My UBA". */
  nickname?: string | null;
}

/**
 * Where a payout goes.
 *
 * Two shapes rather than one nullable id, because "pay a saved beneficiary" and
 * "pay an account the user just typed" are genuinely different operations
 * server-side: the second must run name enquiry and apply whatever third-party
 * transfer rules exist before it can reserve funds. Collapsing them into one
 * optional-field payload hides that from the API.
 */
export type PayoutDestination =
  | { kind: 'beneficiary'; bankAccountId: string }
  | {
      kind: 'oneOff';
      bankCode: string;
      accountNumber: string;
      /** The name returned by resolveAccount — echoed back so the server can
       *  confirm the client showed the user the same name it verified. */
      accountName: string;
      /** Persist as a beneficiary after a successful payout. */
      save?: boolean;
      nickname?: string;
    };

/** Result of a name enquiry against a bank/account pair. */
export interface ResolvedAccount {
  accountName: string;
  bankCode: string;
  accountNumber: string;
}

export type PayoutStatus = 'reserved' | 'processing' | 'settled' | 'failed' | 'reversed';

export interface Payout {
  id: string;
  amountNgn: Decimal;
  fee: Decimal;
  bankAccount: Pick<BankAccount, 'bankName' | 'accountNumber' | 'accountName'>;
  status: PayoutStatus;
  reference: string;
  createdAt: string;
  settledAt: string | null;
  /** Present when status is failed/reversed. */
  failureReason?: string;
}

// ── Unified activity ────────────────────────────────────────────────

export type ActivityKind = 'deposit' | 'sell' | 'giftcard' | 'payout' | 'reversal';

/**
 * One row in the user's history. The backend derives these from ledger
 * journals, so the client never reconstructs a balance from a feed.
 */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  /** Asset moved. NGN for payouts. */
  asset: Asset;
  amount: Decimal;
  /** Naira equivalent, where one applies. */
  ngnValue: Decimal | null;
  /**
   * Union of every kind's states. Wide because the feed is unified — a gift card
   * awaiting review and a deposit awaiting confirmations are both in flight, but
   * they are not the same state and shouldn't be flattened into one.
   */
  status: DepositStatus | PayoutStatus | GiftCardStatus | 'completed';
  createdAt: string;
  /** Kind-specific detail for the row's subtitle. */
  detail?: string;
}

// ── Gift cards ──────────────────────────────────────────────────────

/**
 * What we pay for one brand in one country.
 *
 * Gift card rates are **not** derived from the crypto per-dollar rate. They're
 * set per brand and country by the business, and they sit well below it — a card
 * carries fraud and chargeback risk that a confirmed on-chain deposit does not,
 * and the market prices that in. Nigerian rates also vary sharply by country for
 * the same brand, which is why country is a required choice and not a detail.
 */
export interface GiftCardRate {
  countryCode: string;
  countryName: string;
  /** Face-value currency, e.g. "USD". */
  currency: string;
  /** Naira per unit of face value. */
  ratePerUnit: Decimal;
  minFaceValue: Decimal;
  maxFaceValue: Decimal;
}

export interface GiftCardBrand {
  id: string;
  name: string;
  slug: string;
  /** Remote logo. Null falls back to a lettermark. */
  logoUrl: string | null;
  rates: GiftCardRate[];
  /** Whether a photo of the card is required for review. */
  requiresImage: boolean;
  /** Whether this brand's cards carry a PIN as well as a code. */
  hasPin: boolean;
  /** Operational caveat shown before submitting, e.g. "Receipt required". */
  note?: string | null;
}

export type GiftCardStatus = 'pending' | 'reviewing' | 'approved' | 'rejected';

export interface GiftCardSubmission {
  id: string;
  brandName: string;
  countryCode: string;
  faceValue: Decimal;
  currency: string;
  /** Naira we'll credit on approval. */
  payoutNgn: Decimal;
  status: GiftCardStatus;
  reference: string;
  createdAt: string;
  /** Present when rejected. */
  rejectionReason?: string;
}

// ── Activity detail ─────────────────────────────────────────────────

/** One step in a transaction's progress. */
export interface TimelineStep {
  label: string;
  /** ISO timestamp, or null for a step not yet reached. */
  at: string | null;
  state: 'done' | 'current' | 'pending' | 'failed';
}

/**
 * The receipt.
 *
 * Everything the feed row carries, plus the evidence a user needs when
 * something is disputed or delayed: a reference to quote at support, the chain
 * transaction, the destination account, and where in the process it currently
 * sits.
 *
 * Fields are optional and kind-specific — a payout has no tx hash, a deposit has
 * no bank account. The screen renders whatever is present rather than reserving
 * space for every kind.
 */
export interface ActivityDetail extends ActivityItem {
  /** Quotable at support. Present for anything that moved money. */
  reference?: string;
  /** Ordered progress. Rendered as the receipt's spine. */
  timeline?: TimelineStep[];

  // Deposits
  txHash?: string;
  /** Full URL to a block explorer for `txHash`. */
  explorerUrl?: string;
  network?: string;
  confirmations?: number;
  minConfirmations?: number;

  // Payouts
  bankName?: string;
  accountNumber?: string;
  accountName?: string;

  // Gift cards
  brandName?: string;
  faceValue?: Decimal;
  /** Face-value currency, e.g. "USD". */
  currency?: string;

  /** Rate applied, where one was. */
  rate?: Decimal;
  fee?: Decimal;
  /** Present when the thing failed or was rejected. */
  failureReason?: string;
}

// ── Profile ─────────────────────────────────────────────────────────

export interface Me {
  id: string;
  phone: string | null;
  email: string | null;
  displayName: string | null;
  avatarSeed: string | null;
  kycTier: number;
  hasPin: boolean;
  canWithdraw: boolean;
  nextKycStep: string | null;
}

// ── KYC ─────────────────────────────────────────────────────────────

/** One rung of the verification ladder. */
export interface TierInfo {
  tier: number;
  name: string;
  requirement: string;
  /** "0" means withdrawal is not permitted at that tier. */
  dailyLimitNgn: Decimal;
}

export interface PendingVerification {
  targetTier: number;
  status: string;
  submittedAt: string;
  rejectionReason: string | null;
}

export interface KycStatus {
  tier: number;
  canWithdraw: boolean;
  /** Prose for the prompt. */
  nextStep: string | null;
  /**
   * Which document the next tier needs: bvn | nin | address.
   *
   * The client branches on this rather than on `nextStep`, because matching on
   * an English sentence breaks the moment the copy is reworded.
   */
  nextRequirement: 'bvn' | 'nin' | 'address' | null;
  /** Set while a submission is being reviewed. */
  pending: PendingVerification | null;
  dailyLimitNgn: Decimal;
  tiers: TierInfo[];
}

export interface KycSubmission {
  status: string;
  tier: number;
  message: string;
}

// ── Limits ──────────────────────────────────────────────────────────

export interface Limits {
  kycTier: number;
  /** Remaining payout allowance today. */
  dailyRemainingNgn: Decimal;
  dailyLimitNgn: Decimal;
  perTransactionMaxNgn: Decimal;
  minWithdrawalNgn: Decimal;
}

// ── Errors ──────────────────────────────────────────────────────────

/**
 * Every failure the client renders differently needs its own code — a string
 * message can't be branched on. `QUOTE_EXPIRED` re-quotes, `PIN_INVALID` shakes
 * the pad, `LIMIT_EXCEEDED` shows the limit; a generic 400 can do none of that.
 */
export type ApiErrorCode =
  | 'QUOTE_EXPIRED'
  | 'QUOTE_CONSUMED'
  | 'INSUFFICIENT_BALANCE'
  | 'LIMIT_EXCEEDED'
  | 'PIN_INVALID'
  | 'PIN_LOCKED'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_THROTTLED'
  | 'KYC_REQUIRED'
  | 'BANK_UNVERIFIED'
  | 'ASSET_PAUSED'
  | 'NETWORK'
  | 'UNKNOWN';

export interface ApiError {
  code: ApiErrorCode;
  /** Safe to show the user as-is. */
  message: string;
  /** Extra context, e.g. { limit: "500000" } for LIMIT_EXCEEDED. */
  meta?: Record<string, string>;
}
