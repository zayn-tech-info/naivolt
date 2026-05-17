/**
 * Syncs gift card categories and rates from Prestmit API into your MongoDB.
 * Run once to seed, or on a schedule (e.g. daily cron) to keep rates fresh.
 *
 * Usage:
 *   node scripts/syncPrestmitCategories.js
 *
 * Requires: MONGODB_URI, PRESTMIT_API_KEY, PRESTMIT_API_SECRET in .env
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { getRates } = require('../src/services/prestmit.service');
const GiftCardCategory = require('../src/models/giftCardCategory.model');

// Country code → emoji flag helper
function flag(code) {
  if (!code || code.length !== 2) return '🎁';
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

// Map known card names → emoji
const CARD_EMOJI = {
  amazon: '📦', apple: '🍎', itunes: '🎵', 'google play': '▶️',
  steam: '🎮', netflix: '🎬', spotify: '🎵', playstation: '🎮',
  xbox: '🎮', nintendo: '🎮', ebay: '🛍️', walmart: '🛒',
};

function cardEmoji(name = '') {
  const lower = name.toLowerCase();
  for (const [key, emoji] of Object.entries(CARD_EMOJI)) {
    if (lower.includes(key)) return emoji;
  }
  return '🎁';
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  console.log('Fetching rates from Prestmit…');
  const data = await getRates();

  const { sellableGiftcards = [], giftCardCategories = [] } = data;

  if (!sellableGiftcards.length) {
    console.log('No sellable gift cards returned from Prestmit. Check API credentials.');
    process.exit(1);
  }

  // Group sellable cards by category name
  const categoryMap = {};
  for (const card of sellableGiftcards) {
    const catName = card.category?.name || 'Other';
    if (!categoryMap[catName]) categoryMap[catName] = [];
    categoryMap[catName].push(card);
  }

  let created = 0, updated = 0;

  for (const [catName, cards] of Object.entries(categoryMap)) {
    // Build country rate entries from each card
    const countries = cards.map((card) => ({
      code: card.country?.toUpperCase() || 'US',
      name: card.country || 'United States',
      currency: card.name.match(/\(([A-Z]{2,3})\)/)?.[1] || 'USD',
      ratePerUnit: card.rate || 0,
    }));

    // Deduplicate by country code, keeping highest rate
    const countryMap = {};
    for (const c of countries) {
      if (!countryMap[c.code] || c.ratePerUnit > countryMap[c.code].ratePerUnit) {
        countryMap[c.code] = c;
      }
    }

    const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const prestmitId = cards[0]?.id ?? null;

    const existing = await GiftCardCategory.findOne({ $or: [{ slug }, { name: catName }] });

    if (existing) {
      existing.name = catName;
      existing.slug = slug;
      existing.countries = Object.values(countryMap);
      existing.prestmitGiftcardId = prestmitId;
      existing.isActive = true;
      await existing.save();
      updated++;
      console.log(`  Updated: ${catName} (${Object.keys(countryMap).length} countries)`);
    } else {
      await GiftCardCategory.create({
        name: catName,
        slug,
        emoji: cardEmoji(catName),
        countries: Object.values(countryMap),
        prestmitGiftcardId: prestmitId,
        isActive: true,
      });
      created++;
      console.log(`  Created: ${catName} (${Object.keys(countryMap).length} countries)`);
    }
  }

  console.log(`\nDone. Created: ${created}, Updated: ${updated}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
