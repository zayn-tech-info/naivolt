const GiftCardCategory = require('../models/giftCardCategory.model');
const GiftCardTransaction = require('../models/giftCardTransaction.model');
const BankAccount = require('../models/bankAccount.model');
const { successResponse, errorResponse } = require('../utils/apiResponse');
const { createTransferRecipient, initiateTransfer } = require('../services/paystack.service');
const { submitSellTransaction } = require('../services/prestmit.service');

const userPopulate = { path: 'user', select: 'name username email phone' };

// ─── Category management ────────────────────────────────────────────────────

exports.createCategory = async (req, res) => {
  try {
    const { name, slug, emoji, countries } = req.body;
    if (!name || !slug) return errorResponse(res, 400, 'name and slug are required');
    const category = await GiftCardCategory.create({ name, slug, emoji, countries: countries || [] });
    return successResponse(res, 201, 'Category created', { data: category });
  } catch (err) {
    if (err.code === 11000) return errorResponse(res, 409, 'Category name or slug already exists');
    return errorResponse(res, 500, err.message || 'Failed to create category');
  }
};

exports.updateCategory = async (req, res) => {
  try {
    const category = await GiftCardCategory.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!category) return errorResponse(res, 404, 'Category not found');
    return successResponse(res, 200, 'Category updated', { data: category });
  } catch (err) {
    return errorResponse(res, 500, err.message || 'Failed to update category');
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    const category = await GiftCardCategory.findByIdAndDelete(req.params.id);
    if (!category) return errorResponse(res, 404, 'Category not found');
    return successResponse(res, 200, 'Category deleted');
  } catch (err) {
    return errorResponse(res, 500, 'Failed to delete category');
  }
};

exports.getAllCategories = async (req, res) => {
  try {
    const categories = await GiftCardCategory.find().sort({ name: 1 }).lean();
    return successResponse(res, 200, 'Categories retrieved', { data: categories });
  } catch (err) {
    return errorResponse(res, 500, 'Failed to load categories');
  }
};

// ─── Transaction management ─────────────────────────────────────────────────

exports.getAllGiftCardTransactions = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const transactions = await GiftCardTransaction.find(filter)
      .sort({ createdAt: -1 })
      .populate(userPopulate)
      .lean();

    const userIds = [...new Set(transactions.map((t) => t.user?._id?.toString()).filter(Boolean))];
    const bankAccounts = userIds.length
      ? await BankAccount.find({ userId: { $in: userIds }, isDefault: true }).lean()
      : [];
    const bankMap = Object.fromEntries(bankAccounts.map((b) => [b.userId.toString(), b]));

    const data = transactions.map((t) => ({
      ...t,
      bankAccount: bankMap[t.user?._id?.toString()] ?? null,
    }));

    return successResponse(res, 200, 'Transactions retrieved', { count: data.length, data });
  } catch (err) {
    return errorResponse(res, 500, 'Failed to load gift card transactions');
  }
};

exports.getGiftCardTransactionById = async (req, res) => {
  try {
    const transaction = await GiftCardTransaction.findById(req.params.id)
      .populate(userPopulate)
      .lean();
    if (!transaction) return errorResponse(res, 404, 'Transaction not found');

    const bankAccount = transaction.user?._id
      ? await BankAccount.findOne({ userId: transaction.user._id, isDefault: true }).lean()
      : null;

    return successResponse(res, 200, 'Transaction retrieved', {
      data: { ...transaction, bankAccount },
    });
  } catch (err) {
    if (err.name === 'CastError') return errorResponse(res, 404, 'Transaction not found');
    return errorResponse(res, 500, 'Failed to load transaction');
  }
};

exports.approveGiftCardTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { adminNote } = req.body || {};

    const transaction = await GiftCardTransaction.findById(id).populate('user', 'name email');
    if (!transaction) return errorResponse(res, 404, 'Transaction not found');
    if (!['pending', 'processing'].includes(transaction.status)) {
      return errorResponse(res, 400, 'Only pending or processing transactions can be approved');
    }

    const update = { status: 'processing' };
    if (adminNote?.trim()) update.adminNote = adminNote.trim();

    // If Prestmit is configured and we have a giftcard ID, submit to Prestmit
    // Paystack payout will be triggered automatically via Prestmit webhook
    const prestmitConfigured = process.env.PRESTMIT_API_KEY && process.env.PRESTMIT_API_SECRET;
    const prestmitGiftcardId = transaction.prestmitGiftcardId;

    if (prestmitConfigured && prestmitGiftcardId) {
      // Not already submitted to Prestmit
      if (!transaction.prestmitReference) {
        try {
          const result = await submitSellTransaction({
            giftcardId: prestmitGiftcardId,
            amount: transaction.denomination,
            imagePath: transaction.proofImage,
            cardCode: transaction.cardCode,
            uniqueId: transaction._id.toString(),
          });
          if (result?.trade?.reference) {
            update.prestmitReference = result.trade.reference;
            update.prestmitStatus = 'PENDING';
          }
        } catch (prestmitErr) {
          console.error('[Prestmit] submitSellTransaction error:', prestmitErr?.response?.data || prestmitErr.message);
          // Fall through to manual Paystack payout below
        }
      }

      if (update.prestmitReference) {
        // Submitted to Prestmit — payout triggered by webhook, not now
        const updated = await GiftCardTransaction.findByIdAndUpdate(id, update, { new: true })
          .populate(userPopulate).lean();
        return successResponse(res, 200, 'Submitted to Prestmit for verification. Payout will be sent on approval.', { data: updated });
      }
    }

    // Fallback: manual Paystack payout (no Prestmit or submission failed)
    const bankAccount = await BankAccount.findOne({ userId: transaction.user._id, isDefault: true });
    if (!bankAccount) return errorResponse(res, 400, 'User has no default bank account');
    if (!bankAccount.bankCode) return errorResponse(res, 400, 'Bank account is missing a bank code');

    let recipientCode = transaction.paystackRecipientCode;
    if (!recipientCode) {
      recipientCode = await createTransferRecipient({
        accountName: bankAccount.accountName,
        accountNumber: bankAccount.accountNumber,
        bankCode: bankAccount.bankCode,
      });
    }

    const transfer = await initiateTransfer({
      recipientCode,
      amountNaira: transaction.amountNaira,
      reason: `Naivolt gift card payout — ${transaction.categoryName} ${transaction.currency}${transaction.denomination}`,
      reference: `naivolt_gc_${transaction._id}`,
    });

    update.paystackRecipientCode = recipientCode;
    update.paystackTransferCode = transfer.transfer_code;

    const updated = await GiftCardTransaction.findByIdAndUpdate(id, update, { new: true })
      .populate(userPopulate).lean();

    return successResponse(res, 200, 'Payout initiated', { data: updated });
  } catch (err) {
    if (err.response?.data) return errorResponse(res, 502, err.response.data.message || 'Paystack transfer failed');
    next(err);
  }
};

exports.rejectGiftCardTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNote } = req.body || {};
    if (!adminNote?.trim()) return errorResponse(res, 400, 'Rejection reason is required');

    const transaction = await GiftCardTransaction.findById(id);
    if (!transaction) return errorResponse(res, 404, 'Transaction not found');
    if (!['pending', 'processing'].includes(transaction.status)) {
      return errorResponse(res, 400, 'Only pending or processing transactions can be rejected');
    }

    const updated = await GiftCardTransaction.findByIdAndUpdate(
      id,
      { status: 'rejected', adminNote: adminNote.trim() },
      { new: true }
    ).populate(userPopulate).lean();

    return successResponse(res, 200, 'Transaction rejected', { data: updated });
  } catch (err) {
    return errorResponse(res, 500, 'Failed to reject transaction');
  }
};
