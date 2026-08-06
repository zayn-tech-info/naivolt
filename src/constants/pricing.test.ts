/**
 * Pricing tests.
 *
 * This module decides what every user is paid. The tests below are less about
 * arithmetic (it's one subtraction and one multiplication) and more about the
 * two properties that make the model correct:
 *
 *  1. The margin is uniform across assets. That's the whole reason pricing runs
 *     per dollar instead of per coin, and it is not obvious from reading the
 *     code — it only shows up when you compare BTC against TRX.
 *  2. The rate can never go negative, however the constants are set.
 */

import { USD_NGN_MID, SPREAD_NAIRA_PER_USD, netNgnPerUsd, ngnRateForUsdPrice } from './pricing';

describe('netNgnPerUsd', () => {
  it('is the mid rate less our margin', () => {
    expect(netNgnPerUsd()).toBe(USD_NGN_MID - SPREAD_NAIRA_PER_USD);
  });

  it('pays the user less than mid — never more', () => {
    expect(netNgnPerUsd()).toBeLessThan(USD_NGN_MID);
  });
});

describe('ngnRateForUsdPrice', () => {
  it('converts a USD price at the net rate', () => {
    expect(ngnRateForUsdPrice(1)).toBeCloseTo(netNgnPerUsd(), 6);
    expect(ngnRateForUsdPrice(100)).toBeCloseTo(netNgnPerUsd() * 100, 4);
  });

  it('returns zero for a zero price rather than a negative rate', () => {
    expect(ngnRateForUsdPrice(0)).toBe(0);
  });

  /**
   * The guard that matters: a misconfigured spread larger than the asset's own
   * value must not produce a negative payout. Realistic for a sub-₦10 token.
   */
  it('clamps at zero when the spread exceeds the asset price', () => {
    // A token worth a fraction of a cent, against a ₦10/$ margin.
    const dust = 0.000001;
    expect(ngnRateForUsdPrice(dust)).toBeGreaterThanOrEqual(0);
  });
});

describe('margin uniformity — the reason pricing is per dollar', () => {
  /**
   * Prices spanning five orders of magnitude, which is the real spread of the
   * assets we support. A per-coin margin would earn wildly different amounts
   * across these; a per-dollar one must not.
   */
  const PRICES: Record<string, number> = {
    BTC: 64_000,
    ETH: 1_900,
    BNB: 570,
    SOL: 73,
    USDT: 1,
    TRX: 0.325,
  };

  const SALE_NGN = 1_000_000;

  it('takes the same margin on a ₦1m sale regardless of asset', () => {
    const margins = Object.values(PRICES).map((usdPrice) => {
      const netRate = ngnRateForUsdPrice(usdPrice);
      const midRate = usdPrice * USD_NGN_MID;
      // Units the user must sell to receive SALE_NGN at our rate.
      const units = SALE_NGN / netRate;
      // What those units were worth at mid — the difference is our margin.
      return units * midRate - SALE_NGN;
    });

    const first = margins[0];
    for (const margin of margins) {
      expect(margin).toBeCloseTo(first, 2);
    }
  });

  it('takes the expected percentage, whatever the asset', () => {
    const expectedPct = SPREAD_NAIRA_PER_USD / USD_NGN_MID;

    for (const usdPrice of Object.values(PRICES)) {
      const midRate = usdPrice * USD_NGN_MID;
      const netRate = ngnRateForUsdPrice(usdPrice);
      expect((midRate - netRate) / midRate).toBeCloseTo(expectedPct, 10);
    }
  });

  /**
   * Regression guard for the bug this model replaced. A flat ₦10 off each
   * *coin's* rate earned ₦10 on a ₦98m BTC sale (0.00001%) while charging ~2%
   * on TRX. If someone reintroduces per-coin spread, this fails.
   */
  it('does not degenerate on high-value assets', () => {
    const btcNet = ngnRateForUsdPrice(PRICES.BTC);
    const btcMid = PRICES.BTC * USD_NGN_MID;
    const marginPct = (btcMid - btcNet) / btcMid;

    // Anything at or below a basis point means the margin has collapsed.
    expect(marginPct).toBeGreaterThan(0.0001);
  });
});
