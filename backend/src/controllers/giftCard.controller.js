const fs = require('fs');
const cloudinary = require('../config/cloudinary');
const GiftCardCategory = require('../models/giftCardCategory.model');
const GiftCardTransaction = require('../models/giftCardTransaction.model');
const { successResponse, errorResponse } = require('../utils/apiResponse');

// GET /api/v1/gift-cards/categories
exports.getCategories = async (req, res) => {
  try {
    const categories = await GiftCardCategory.find({ isActive: true })
      .select('name slug emoji countries')
      .sort({ name: 1 })
      .lean();
    return successResponse(res, 200, 'Categories retrieved', { data: categories });
  } catch (err) {
    return errorResponse(res, 500, 'Failed to load gift card categories');
  }
};

// POST /api/v1/gift-cards/transactions
exports.submitGiftCard = async (req, res) => {
  try {
    const { categoryId, country, denomination, cardCode, cardPin } = req.body;

    if (!categoryId || !country || !denomination || !cardCode) {
      return errorResponse(res, 400, 'categoryId, country, denomination, and cardCode are required');
    }
    if (!req.file) {
      return errorResponse(res, 400, 'Proof image is required');
    }

    const category = await GiftCardCategory.findById(categoryId);
    if (!category || !category.isActive) {
      return errorResponse(res, 404, 'Gift card category not found or inactive');
    }

    const countryRate = category.countries.find((c) => c.code === country.toUpperCase());
    if (!countryRate) {
      return errorResponse(res, 400, `No rate configured for country: ${country}`);
    }

    const denom = Number(denomination);
    if (!denom || denom <= 0) {
      return errorResponse(res, 400, 'denomination must be a positive number');
    }

    const amountNaira = Math.round(denom * countryRate.ratePerUnit);

    // Upload proof image
    let proofImage = '';
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      try {
        const result = await cloudinary.uploader.upload(req.file.path, {
          folder: 'naivolt/giftcard-proofs',
          resource_type: 'image',
        });
        proofImage = result.secure_url || result.url;
      } catch (err) {
        fs.unlink(req.file.path, () => {});
        return errorResponse(res, 500, 'Image upload failed. Please try again.');
      }
      fs.unlink(req.file.path, () => {});
    } else {
      proofImage = req.file.path;
    }

    const transaction = await GiftCardTransaction.create({
      user: req.user._id,
      categoryId: category._id,
      categoryName: category.name,
      emoji: category.emoji,
      country: country.toUpperCase(),
      currency: countryRate.currency,
      denomination: denom,
      cardCode: String(cardCode).trim(),
      cardPin: cardPin ? String(cardPin).trim() : '',
      proofImage,
      amountNaira,
      rateAtTime: countryRate.ratePerUnit,
      status: 'pending',
    });

    return successResponse(res, 201, 'Gift card submitted successfully', {
      data: {
        _id: transaction._id,
        categoryName: transaction.categoryName,
        denomination: transaction.denomination,
        currency: transaction.currency,
        amountNaira: transaction.amountNaira,
        status: transaction.status,
        createdAt: transaction.createdAt,
      },
    });
  } catch (err) {
    console.error('submitGiftCard error:', err);
    return errorResponse(res, 500, err.message || 'Failed to submit gift card');
  }
};

// GET /api/v1/gift-cards/transactions
exports.getMyGiftCardTransactions = async (req, res) => {
  try {
    const transactions = await GiftCardTransaction.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .select('-cardCode -cardPin')
      .lean();
    return successResponse(res, 200, 'Transactions retrieved', { data: transactions });
  } catch (err) {
    return errorResponse(res, 500, 'Failed to load gift card transactions');
  }
};

// GET /api/v1/gift-cards/transactions/:id
exports.getGiftCardTransactionById = async (req, res) => {
  try {
    const transaction = await GiftCardTransaction.findOne({
      _id: req.params.id,
      user: req.user._id,
    }).lean();
    if (!transaction) return errorResponse(res, 404, 'Transaction not found');
    return successResponse(res, 200, 'Transaction retrieved', { data: transaction });
  } catch (err) {
    if (err.name === 'CastError') return errorResponse(res, 404, 'Transaction not found');
    return errorResponse(res, 500, 'Failed to load transaction');
  }
};
