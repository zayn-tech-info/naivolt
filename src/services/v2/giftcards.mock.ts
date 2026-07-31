/**
 * Gift card fixture.
 *
 * Rates are naira per unit of face value, at levels plausible for the Nigerian
 * market. They are deliberately **well below** the crypto per-dollar rate
 * (~₦1,520 at the time of writing): a gift card carries fraud, chargeback and
 * resale risk that a confirmed on-chain deposit does not, and the market prices
 * that in. A card quoted at parity with crypto would be a red flag, not a
 * feature.
 *
 * Rates also vary sharply by country for the same brand — US cards typically
 * clear below UK ones, and Canadian below both. That spread is why country is a
 * required choice in the UI rather than a footnote.
 *
 * The real list comes from the backend (and, per the v1 code, ultimately from a
 * provider like Prestmit). These values exist so the screen is usable and the
 * rate arithmetic is exercised during development.
 */

import type { GiftCardBrand, GiftCardRate } from './types';

function rate(
  countryCode: string,
  countryName: string,
  currency: string,
  ratePerUnit: number,
  min = 10,
  max = 1000
): GiftCardRate {
  return {
    countryCode,
    countryName,
    currency,
    ratePerUnit: ratePerUnit.toFixed(4),
    minFaceValue: min.toFixed(2),
    maxFaceValue: max.toFixed(2),
  };
}

export const MOCK_GIFT_CARD_BRANDS: GiftCardBrand[] = [
  {
    id: 'gc_amazon',
    name: 'Amazon',
    slug: 'amazon',
    logoUrl: 'https://logo.clearbit.com/amazon.com',
    requiresImage: true,
    hasPin: false,
    note: 'Receipt required for cards over $200.',
    rates: [
      rate('US', 'United States', 'USD', 1080),
      rate('GB', 'United Kingdom', 'GBP', 1320),
      rate('CA', 'Canada', 'CAD', 880),
      rate('DE', 'Germany', 'EUR', 1150),
    ],
  },
  {
    id: 'gc_itunes',
    name: 'iTunes',
    slug: 'itunes',
    logoUrl: 'https://logo.clearbit.com/apple.com',
    requiresImage: true,
    hasPin: false,
    rates: [
      rate('US', 'United States', 'USD', 1160),
      rate('GB', 'United Kingdom', 'GBP', 1280),
      rate('CA', 'Canada', 'CAD', 900),
    ],
  },
  {
    id: 'gc_steam',
    name: 'Steam',
    slug: 'steam',
    logoUrl: 'https://logo.clearbit.com/steampowered.com',
    requiresImage: true,
    hasPin: false,
    rates: [
      rate('US', 'United States', 'USD', 1240),
      rate('GB', 'United Kingdom', 'GBP', 1300),
    ],
  },
  {
    id: 'gc_google_play',
    name: 'Google Play',
    slug: 'google-play',
    logoUrl: 'https://logo.clearbit.com/play.google.com',
    requiresImage: true,
    hasPin: false,
    rates: [
      rate('US', 'United States', 'USD', 1100),
      rate('GB', 'United Kingdom', 'GBP', 1240),
    ],
  },
  {
    id: 'gc_playstation',
    name: 'PlayStation',
    slug: 'playstation',
    logoUrl: 'https://logo.clearbit.com/playstation.com',
    requiresImage: true,
    hasPin: false,
    rates: [
      rate('US', 'United States', 'USD', 1120),
      rate('GB', 'United Kingdom', 'GBP', 1260),
    ],
  },
  {
    id: 'gc_xbox',
    name: 'Xbox',
    slug: 'xbox',
    logoUrl: 'https://logo.clearbit.com/xbox.com',
    requiresImage: true,
    hasPin: false,
    rates: [rate('US', 'United States', 'USD', 1040), rate('GB', 'United Kingdom', 'GBP', 1180)],
  },
  {
    id: 'gc_sephora',
    name: 'Sephora',
    slug: 'sephora',
    logoUrl: 'https://logo.clearbit.com/sephora.com',
    requiresImage: true,
    hasPin: false,
    note: 'US cards only.',
    rates: [rate('US', 'United States', 'USD', 1290)],
  },
  {
    id: 'gc_nike',
    name: 'Nike',
    slug: 'nike',
    logoUrl: 'https://logo.clearbit.com/nike.com',
    requiresImage: true,
    hasPin: false,
    rates: [rate('US', 'United States', 'USD', 1200)],
  },
  {
    id: 'gc_netflix',
    name: 'Netflix',
    slug: 'netflix',
    logoUrl: 'https://logo.clearbit.com/netflix.com',
    requiresImage: true,
    hasPin: true,
    rates: [rate('US', 'United States', 'USD', 980)],
  },
  {
    id: 'gc_ebay',
    name: 'eBay',
    slug: 'ebay',
    logoUrl: 'https://logo.clearbit.com/ebay.com',
    requiresImage: true,
    hasPin: false,
    rates: [rate('US', 'United States', 'USD', 1020)],
  },
  {
    id: 'gc_vanilla',
    name: 'Vanilla / Visa',
    slug: 'vanilla',
    logoUrl: 'https://logo.clearbit.com/vanillagift.com',
    requiresImage: true,
    hasPin: true,
    note: 'Must show full card front and back.',
    rates: [rate('US', 'United States', 'USD', 890, 25, 500)],
  },
  {
    id: 'gc_walmart',
    name: 'Walmart',
    slug: 'walmart',
    logoUrl: 'https://logo.clearbit.com/walmart.com',
    requiresImage: true,
    hasPin: false,
    rates: [rate('US', 'United States', 'USD', 1060)],
  },
];
