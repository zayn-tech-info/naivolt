const path = require('path');
const fs = require('fs');
const cloudinary = require('../config/cloudinary');
const Transaction = require('../models/transaction.model');
const WalletAddress = require('../models/walletAddress.model');
const { successResponse, errorResponse } = require('../utils/apiResponse');

exports.getMyTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .select('_id coin network amountCrypto amountNaira rateAtTime status createdAt transactionHash proofImage')
      .lean();
    return successResponse(res, 200, 'Transactions retrieved', { data: transactions });
  } catch (err) {
    console.error('Get transactions error:', err);
    return errorResponse(res, 500, err.message || 'Failed to load transactions');
  }
};

exports.getTransactionById = async (req, res) => {
  try {
    const { id } = req.params;
    const transaction = await Transaction.findOne({ _id: id, user: req.user._id }).lean();
    if (!transaction) {
      return errorResponse(res, 404, 'Transaction not found');
    }
    return successResponse(res, 200, 'Transaction retrieved', { data: transaction });
  } catch (err) {
    if (err.name === 'CastError' && err.kind === 'ObjectId') {
      return errorResponse(res, 404, 'Transaction not found');
    }
    console.error('Get transaction by id error:', err);
    return errorResponse(res, 500, err.message || 'Failed to load transaction');
  }
};

exports.submitTransaction = async (req, res) => {
  let proofUrl = '';
  try {
    const { coin, network, amountCrypto, amountNaira, rateAtTime, transactionHash, depositAddressId } = req.body;

    if (!coin || !network || amountCrypto == null || amountNaira == null || rateAtTime == null) {
      return errorResponse(res, 400, 'Missing required fields: coin, network, amountCrypto, amountNaira, rateAtTime');
    }

    if (!req.file || !req.file.path) {
      return errorResponse(res, 400, 'Proof image is required');
    }

    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      try {
        const result = await cloudinary.uploader.upload(req.file.path, {
          folder: 'naivolt/proofs',
          resource_type: 'image',
        });
        proofUrl = result.secure_url || result.url;
      } catch (cloudErr) {
        console.error('Cloudinary upload error:', cloudErr);
        fs.unlink(req.file.path, () => {});
        return errorResponse(res, 500, cloudErr.message || 'Image upload failed. Try again.');
      }
      fs.unlink(req.file.path, () => {});
    } else {
      proofUrl = req.file.path;
    }

    // Lock the deposit address to this transaction
    let depositAddress = '';
    let resolvedAddressId = null;
    if (depositAddressId) {
      const walletDoc = await WalletAddress.findByIdAndUpdate(
        depositAddressId,
        { isAvailable: false, assignedAt: new Date() },
        { new: true }
      );
      if (walletDoc) {
        depositAddress = walletDoc.address;
        resolvedAddressId = walletDoc._id;
      }
    }

    const transaction = await Transaction.create({
      user: req.user._id,
      coin: String(coin).trim(),
      network: String(network).trim(),
      amountCrypto: Number(amountCrypto),
      amountNaira: Number(amountNaira),
      rateAtTime: Number(rateAtTime),
      depositAddress,
      depositAddressId: resolvedAddressId,
      transactionHash: transactionHash ? String(transactionHash).trim() : '',
      proofImage: proofUrl,
      status: 'pending',
    });

    // Link the wallet address record back to the transaction for audit
    if (resolvedAddressId) {
      await WalletAddress.findByIdAndUpdate(resolvedAddressId, { assignedTo: transaction._id });
    }

    return successResponse(res, 201, 'Transaction submitted successfully', {
      transaction: {
        _id: transaction._id,
        coin: transaction.coin,
        network: transaction.network,
        amountCrypto: transaction.amountCrypto,
        amountNaira: transaction.amountNaira,
        status: transaction.status,
        createdAt: transaction.createdAt,
      },
    });
  } catch (err) {
    console.error('Submit transaction error:', err);
    return errorResponse(res, 500, err.message || 'Failed to submit transaction');
  }
};
