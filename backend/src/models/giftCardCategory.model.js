const mongoose = require('mongoose');

const countryRateSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true },   // "US"
    name: { type: String, required: true, trim: true },                    // "United States"
    currency: { type: String, required: true, trim: true, uppercase: true }, // "USD"
    ratePerUnit: { type: Number, required: true, min: 0 },                 // NGN per 1 unit face value
  },
  { _id: false }
);

const giftCardCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },  // "Amazon"
    slug: { type: String, required: true, trim: true, unique: true, lowercase: true }, // "amazon"
    emoji: { type: String, trim: true, default: '🎁' },
    isActive: { type: Boolean, default: true },
    countries: { type: [countryRateSchema], default: [] },
  },
  { timestamps: true, versionKey: false }
);

const GiftCardCategory = mongoose.model('GiftCardCategory', giftCardCategorySchema);
module.exports = GiftCardCategory;
