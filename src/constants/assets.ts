/**
 * Which assets exist on which chains.
 *
 * Sourced from the derivation table in docs/ARCHITECTURE.md §4. The pairing
 * matters more than either half: USDT exists on four of these chains with a
 * different address format on each, and the app must never present an
 * asset/network combination the backend can't derive an address for.
 */

import type { Asset, Chain, ChainMeta } from '@/services/v2/types';

export const CHAIN_META: Record<Chain, ChainMeta> = {
  tron: { chain: 'tron', network: 'TRC-20', label: 'Tron', minConfirmations: 20 },
  ethereum: { chain: 'ethereum', network: 'ERC-20', label: 'Ethereum', minConfirmations: 12 },
  bsc: { chain: 'bsc', network: 'BEP-20', label: 'BNB Chain', minConfirmations: 20 },
  polygon: { chain: 'polygon', network: 'Polygon', label: 'Polygon', minConfirmations: 20 },
  base: { chain: 'base', network: 'Base', label: 'Base', minConfirmations: 10 },
  bitcoin: { chain: 'bitcoin', network: 'Bitcoin', label: 'Bitcoin', minConfirmations: 2 },
  solana: { chain: 'solana', network: 'Solana', label: 'Solana', minConfirmations: 1 },
};

/**
 * Networks per asset, cheapest-and-most-used first — TRC-20 is the default USDT
 * rail in Nigeria and ordering it first is what most users need.
 */
export const CHAINS_FOR_ASSET: Partial<Record<Asset, ChainMeta[]>> = {
  USDT: [CHAIN_META.tron, CHAIN_META.bsc, CHAIN_META.ethereum, CHAIN_META.polygon],
  USDC: [CHAIN_META.base, CHAIN_META.ethereum, CHAIN_META.polygon, CHAIN_META.solana],
  BTC: [CHAIN_META.bitcoin],
  ETH: [CHAIN_META.ethereum, CHAIN_META.base],
  BNB: [CHAIN_META.bsc],
  SOL: [CHAIN_META.solana],
};

/** Assets a user can deposit. NGN is excluded — naira arrives only by selling. */
export const DEPOSITABLE_ASSETS: Asset[] = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'SOL'];

/**
 * Validate an asset arriving as a route param or deep link.
 *
 * Route params are strings from an untrusted source — a deep link can name
 * anything. Returning null rather than casting is what stops a bad link
 * rendering a deposit screen for an asset with no derivable address.
 */
export function parseAsset(raw: string | string[] | undefined): Asset | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const upper = value.toUpperCase() as Asset;
  return DEPOSITABLE_ASSETS.includes(upper) ? upper : null;
}

/**
 * Validate a chain *for a specific asset*.
 *
 * Checking the pair, not the chain alone: `bitcoin` is a real chain and `USDT`
 * is a real asset, but USDT-on-Bitcoin has no address to derive. Accepting the
 * pair because both halves look valid is how a user ends up with a screen
 * telling them to send funds somewhere that cannot receive them.
 */
export function parseChainFor(asset: Asset, raw: string | string[] | undefined): Chain | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const supported = CHAINS_FOR_ASSET[asset] ?? [];
  return supported.find((meta) => meta.chain === value)?.chain ?? null;
}
