const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    coin: { type: String, required: true, trim: true },
    network: { type: String, required: true, trim: true },
    amountCrypto: { type: Number, required: true },
    amountNaira: { type: Number, required: true },
    rateAtTime: { type: Number, required: true },
    depositAddress: { type: String, trim: true, default: '' },
    depositAddressId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletAddress', default: null },
    transactionHash: { type: String, trim: true, default: '' },
    proofImage: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'processing', 'paid', 'rejected'],
      default: 'pending',
    },
    paidAt: { type: Date },
    adminNote: { type: String, trim: true },
    paystackRecipientCode: { type: String, trim: true },
    paystackTransferCode: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

const Transaction = mongoose.model('Transaction', transactionSchema);
module.exports = Transaction;
