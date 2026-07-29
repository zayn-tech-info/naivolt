/**
 * Pricing — the business's margin, in one place.
 *
 * ## The rate is naira per dollar
 *
 * Everything is priced through a single number: what we pay per US dollar of
 * value. That's the number Nigerian users actually mean when they ask "what's the
 * rate today?", and it's how every competitor quotes — "₦1,520/$", not
 * "1 BTC = ₦97,806,770".
 *
 * Framing it this way also makes the margin coherent. The spread is a flat ₦10
 * off the per-dollar rate, which works out to the same ~0.65% whether someone
 * sells ₦2,000 of TRX or ₦98,000,000 of BTC:
 *
 *     payout = assetAmount × assetUsdPrice × (ngnPerUsdMid − 10)
 *
 * Applying a flat naira spread *per coin* instead — which is the other reading of
 * "₦10 gap" — collapses: one BTC is worth ~64,000 USDT, so ₦10 per coin is 0.65%
 * on USDT and 0.00001% on BTC, earning ₦10 total on a ₦98m sale. Per dollar, one
 * constant covers every asset.
 *
 * ## Why USD, not CoinGecko's NGN
 *
 * CoinGecko will return `vs_currency=ngn`, but that's derived from the *official*
 * USD/NGN rate — it prices USDT around ₦1,364 while the parallel market, where
 * every Nigerian actually trades, sits well above it. Pricing off it would make
 * our rates look ~10-12% worse than the competition on every asset. So we take
 * the USD price, which is a real deep-market number, and apply our own naira
 * rate.
 *
 * ## Where this belongs long-term
 *
 * Nowhere near the client. ARCHITECTURE.md §9 puts rates and spread in the
 * `rates` service, and that's correct: a spread computed on the device is
 * readable by anyone who opens the bundle, and it can't be *enforced* — only the
 * server issuing the quote can guarantee a price. This file exists so the app
 * shows real numbers before that service is built, and so there is exactly one
 * place to read the values off when porting them.
 */

/**
 * Mid naira per US dollar — the parallel-market rate before our margin.
 *
 * Override per build with `EXPO_PUBLIC_USD_NGN_RATE`. The fallback drifts and is
 * not a substitute for a live FX feed, which is the `rates` service's job.
 */
export const USD_NGN_MID = Number(process.env.EXPO_PUBLIC_USD_NGN_RATE) || 1530;

/**
 * Our margin, in naira per dollar of value transacted.
 *
 * At a ₦1,530 mid this is ~0.65%, applied uniformly to every asset. Raise it to
 * ~₦20 to hit the 1.3% target in ARCHITECTURE.md §9.
 *
 * Never shown to the user. They see one rate and receive exactly that rate; the
 * margin is embedded, which is how every exchange quotes.
 */
export const SPREAD_NAIRA_PER_USD =
  Number(process.env.EXPO_PUBLIC_SPREAD_NGN_PER_USD) || 10;

/**
 * The rate we pay: mid less our margin.
 *
 * Clamped so a misconfigured spread larger than the rate itself can't produce a
 * negative payout.
 */
export function netNgnPerUsd(): number {
  return Math.max(0, USD_NGN_MID - SPREAD_NAIRA_PER_USD);
}

/** Naira we pay per unit of an asset, given its USD price. */
export function ngnRateForUsdPrice(usdPrice: number): number {
  return Math.max(0, usdPrice * netNgnPerUsd());
}
