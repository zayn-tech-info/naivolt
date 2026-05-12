const mongoose = require('mongoose');

const giftCardTransactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'GiftCardCategory', required: true },
    categoryName: { type: String, required: true, trim: true },
    emoji: { type: String, default: '🎁' },
    country: { type: String, required: true, trim: true },      // "US"
    currency: { type: String, required: true, trim: true },     // "USD"
    denomination: { type: Number, required: true },             // face value e.g. 100
    cardCode: { type: String, required: true, trim: true },
    cardPin: { type: String, trim: true, default: '' },
    proofImage: { type: String, default: '' },
    amountNaira: { type: Number, required: true },
    rateAtTime: { type: Number, required: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'paid', 'rejected'],
      default: 'pending',
    },
    adminNote: { type: String, trim: true },
    paidAt: { type: Date },
    paystackRecipientCode: { type: String, trim: true },
    paystackTransferCode: { type: String, trim: true },
  },
  { timestamps: true, versionKey: false }
);

giftCardTransactionSchema.index({ user: 1, createdAt: -1 });
giftCardTransactionSchema.index({ status: 1 });

const GiftCardTransaction = mongoose.model('GiftCardTransaction', giftCardTransactionSchema);
module.exports = GiftCardTransaction;
