const mongoose = require('mongoose');

const walletAddressSchema = new mongoose.Schema(
  {
    coin: { type: String, required: true, trim: true, uppercase: true },
    network: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true, unique: true },
    isAvailable: { type: Boolean, default: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    assignedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

walletAddressSchema.index({ coin: 1, isAvailable: 1 });

const WalletAddress = mongoose.model('WalletAddress', walletAddressSchema);
module.exports = WalletAddress;
