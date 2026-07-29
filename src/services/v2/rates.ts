/**
 * Live rates — development stand-in for the `rates` service.
 *
 * Fetches real USD prices from CoinGecko and converts through our own naira rate.
 * See constants/pricing.ts for why the conversion works that way and why the
 * margin is a per-dollar figure rather than a per-coin one.
 *
 * ## What leaves this module
 *
 * Only net figures. The mid naira rate and the spread stay inside pricing.ts and
 * never appear on a type the UI can read — so no screen can render our margin by
 * accident, and no future component can reach for it, because it isn't there.
 *
 * ## Failure behaviour
 *
 * A stale price is dangerous in a different way from a missing one: quoting off a
 * twenty-minute-old price can mean buying above market. So the cache serves stale
 * data only up to STALE_LIMIT_MS, past which a failed fetch surfaces as an error
 * rather than a confident wrong number. That mirrors ARCHITECTURE.md §9, where
 * quoting freezes rather than guessing.
 *
 * In production this module goes away: `/rates`, `/portfolio` and `/quotes` carry
 * server-computed figures and the client does no pricing at all.
 */

import type { Asset } from './types';
import { netNgnPerUsd, ngnRateForUsdPrice } from '@/constants/pricing';

/** CoinGecko ids for the assets we price. */
const COINGECKO_ID: Partial<Record<Asset, string>> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  BNB: 'binancecoin',
  SOL: 'solana',
  TRX: 'tron',
};

const ID_TO_ASSET: Record<string, Asset> = Object.entries(COINGECKO_ID).reduce(
  (acc, [asset, id]) => {
    if (id) acc[id] = asset as Asset;
    return acc;
  },
  {} as Record<string, Asset>
);

const ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';
const FETCH_TIMEOUT_MS = 8000;

/** Serve from cache within this window without refetching. */
const CACHE_TTL_MS = 30_000;
/** Beyond this, a stale price is worse than no price. */
const STALE_LIMIT_MS = 5 * 60_000;

interface UsdQuote {
  usd: number;
  /** 24h move as a percentage. Asset-level, so identical in NGN terms. */
  changePct24h: number | null;
}

interface PriceCache {
  usd: Partial<Record<Asset, UsdQuote>>;
  fetchedAt: number;
}

let cache: PriceCache | null = null;
/** In-flight request, so concurrent callers share one network hit. */
let inFlight: Promise<PriceCache> | null = null;

async function fetchUsdPrices(): Promise<Partial<Record<Asset, UsdQuote>>> {
  const ids = Object.values(COINGECKO_ID).filter(Boolean).join(',');
  const url = `${ENDPOINT}?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

  // CoinGecko's free tier can hang rather than fail fast; without a timeout a
  // stalled request would leave the rate rows spinning indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);

    const body = (await res.json()) as Record<
      string,
      { usd?: number; usd_24h_change?: number }
    >;
    const prices: Partial<Record<Asset, UsdQuote>> = {};

    for (const [id, entry] of Object.entries(body)) {
      const asset = ID_TO_ASSET[id];
      const usd = entry?.usd;
      // Skip rather than default to zero: a zero price would render as a real
      // rate of ₦0 and let someone sell into it.
      if (asset && typeof usd === 'number' && usd > 0) {
        prices[asset] = {
          usd,
          changePct24h:
            typeof entry.usd_24h_change === 'number' ? entry.usd_24h_change : null,
        };
      }
    }

    if (Object.keys(prices).length === 0) {
      throw new Error('CoinGecko returned no usable prices');
    }
    return prices;
  } finally {
    clearTimeout(timer);
  }
}

async function loadPrices(): Promise<PriceCache> {
  const age = cache ? Date.now() - cache.fetchedAt : Infinity;
  if (cache && age < CACHE_TTL_MS) return cache;

  if (!inFlight) {
    inFlight = fetchUsdPrices()
      .then((usd) => {
        const next = { usd, fetchedAt: Date.now() };
        cache = next;
        return next;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  try {
    return await inFlight;
  } catch (err) {
    // Serve a recent-but-stale price rather than failing outright; refuse once
    // it's old enough that quoting off it would be a real risk.
    if (cache && Date.now() - cache.fetchedAt < STALE_LIMIT_MS) return cache;
    throw err;
  }
}

export interface LiveRates {
  /** Net naira per US dollar — the headline rate. */
  ngnPerUsd: number;
  /** Per-asset USD price, net naira rate, and 24h movement. */
  assets: { asset: Asset; usdPrice: number; rate: number; changePct24h: number | null }[];
  asOf: number;
}

/**
 * The full board. Throws if there is no price fresh enough to quote against.
 */
export async function getLiveRates(): Promise<LiveRates> {
  const { usd, fetchedAt } = await loadPrices();
  const ngnPerUsd = netNgnPerUsd();

  const assets = (Object.entries(usd) as [Asset, UsdQuote][])
    .map(([asset, quote]) => ({
      asset,
      usdPrice: quote.usd,
      rate: ngnRateForUsdPrice(quote.usd),
      changePct24h: quote.changePct24h,
    }))
    .filter((row) => row.rate > 0)
    // Highest value first — BTC at the top reads as a price list, not a jumble.
    .sort((a, b) => b.usdPrice - a.usdPrice);

  return { ngnPerUsd, assets, asOf: fetchedAt };
}

/** Net naira rates per unit, keyed by asset. For valuing balances. */
export async function getSellRates(): Promise<Partial<Record<Asset, number>>> {
  const { assets } = await getLiveRates();
  return assets.reduce<Partial<Record<Asset, number>>>((acc, row) => {
    acc[row.asset] = row.rate;
    return acc;
  }, {});
}

/** Test/dev helper — drops the cache so the next call refetches. */
export function resetRateCache(): void {
  cache = null;
  inFlight = null;
}
