const Transaction = require("../models/transaction.model");
const User = require("../models/user.model");
const BankAccount = require("../models/bankAccount.model");
const { successResponse, errorResponse } = require("../utils/apiResponse");
const { createTransferRecipient, initiateTransfer } = require("../services/paystack.service");

const userPopulate = { path: "user", select: "name username email phone" };

exports.getAllTransactions = async (req, res, next) => {
  try {
    const { status, coin, search } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (coin) filter.coin = coin;

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      const users = await User.find({
        $or: [{ name: regex }, { email: regex }],
      }).select("_id");
      const userIds = users.map((u) => u._id);
      filter.user = { $in: userIds };
    }

    const transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .populate(userPopulate)
      .lean();

    const userIds = [
      ...new Set(
        transactions
          .map((t) => t.user?._id?.toString())
          .filter((id) => Boolean(id))
      ),
    ];

    const bankAccounts = userIds.length
      ? await BankAccount.find({
          userId: { $in: userIds },
          isDefault: true,
        }).lean()
      : [];

    const bankAccountMap = {};
    for (const account of bankAccounts) {
      bankAccountMap[account.userId.toString()] = account;
    }

    const transactionsWithBank = transactions.map((t) => {
      const userId = t.user?._id?.toString();
      const bankAccount = userId ? bankAccountMap[userId] ?? null : null;
      return {
        ...t,
        bankAccount,
      };
    });

    return successResponse(res, 200, "Transactions retrieved", {
      count: transactionsWithBank.length,
      data: transactionsWithBank,
    });
  } catch (err) {
    next(err);
  }
};

exports.getTransactionById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const transaction = await Transaction.findById(id)
      .populate(userPopulate)
      .lean();

    if (!transaction) {
      return errorResponse(res, 404, "Transaction not found");
    }

    const userId = transaction.user?._id;
    const bankAccount = userId
      ? await BankAccount.findOne({
          userId,
          isDefault: true,
        }).lean()
      : null;

    return successResponse(res, 200, "Transaction retrieved", {
      data: {
        ...transaction,
        bankAccount: bankAccount ?? null,
      },
    });
  } catch (err) {
    if (err.name === "CastError" && err.kind === "ObjectId") {
      return errorResponse(res, 404, "Transaction not found");
    }
    next(err);
  }
};

exports.approveTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { adminNote } = req.body || {};

    const transaction = await Transaction.findById(id).populate("user", "name email");
    if (!transaction) {
      return errorResponse(res, 404, "Transaction not found");
    }
    if (transaction.status !== "pending" && transaction.status !== "processing") {
      return errorResponse(res, 400, "Only pending or processing transactions can be approved");
    }

    // Get user's default bank account
    const bankAccount = await BankAccount.findOne({
      userId: transaction.user._id,
      isDefault: true,
    });

    if (!bankAccount) {
      return errorResponse(res, 400, "User has no default bank account saved");
    }
    if (!bankAccount.bankCode) {
      return errorResponse(res, 400, "User's bank account is missing a bank code — ask them to re-save their bank details");
    }

    // Create Paystack transfer recipient (or reuse stored one)
    let recipientCode = transaction.paystackRecipientCode;
    if (!recipientCode) {
      recipientCode = await createTransferRecipient({
        accountName: bankAccount.accountName,
        accountNumber: bankAccount.accountNumber,
        bankCode: bankAccount.bankCode,
      });
    }

    // Initiate the transfer — transaction moves to "processing" until webhook confirms
    const transfer = await initiateTransfer({
      recipientCode,
      amountNaira: transaction.amountNaira,
      reason: `Naivolt payout — ${transaction.coin} conversion`,
      reference: `naivolt_${transaction._id}`,
    });

    const update = {
      status: "processing",
      paystackRecipientCode: recipientCode,
      paystackTransferCode: transfer.transfer_code,
    };
    if (adminNote != null && String(adminNote).trim() !== "") {
      update.adminNote = String(adminNote).trim();
    }

    const updated = await Transaction.findByIdAndUpdate(id, update, { new: true })
      .populate(userPopulate)
      .lean();

    return successResponse(res, 200, "Payout initiated — transaction is processing", {
      data: updated,
    });
  } catch (err) {
    // Surface Paystack API errors clearly
    if (err.response?.data) {
      return errorResponse(res, 502, err.response.data.message || "Paystack transfer failed");
    }
    next(err);
  }
};

exports.rejectTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { adminNote } = req.body || {};

    if (!adminNote || String(adminNote).trim() === "") {
      return errorResponse(res, 400, "Rejection reason is required");
    }

    const transaction = await Transaction.findById(id);
    if (!transaction) {
      return errorResponse(res, 404, "Transaction not found");
    }
    if (transaction.status !== "pending" && transaction.status !== "processing") {
      return errorResponse(res, 400, "Only pending or processing transactions can be rejected");
    }

    const updated = await Transaction.findByIdAndUpdate(
      id,
      {
        status: "rejected",
        adminNote: String(adminNote).trim(),
      },
      { new: true }
    )
      .populate(userPopulate)
      .lean();

    return successResponse(res, 200, "Transaction rejected", {
      data: updated,
    });
  } catch (err) {
    next(err);
  }
};

exports.getAdminStats = async (req, res, next) => {
  try {
    const [totalTransactions, pending, processing, paid, rejected, paidSums, totalUsers] =
      await Promise.all([
        Transaction.countDocuments(),
        Transaction.countDocuments({ status: "pending" }),
        Transaction.countDocuments({ status: "processing" }),
        Transaction.countDocuments({ status: "paid" }),
        Transaction.countDocuments({ status: "rejected" }),
        Transaction.aggregate([
          { $match: { status: "paid" } },
          {
            $group: {
              _id: null,
              totalCryptoPaid: { $sum: "$amountCrypto" },
              totalNairaPaid: { $sum: "$amountNaira" },
            },
          },
        ]),
        User.countDocuments({ role: "user" }),
      ]);

    const sums = paidSums[0] || {
      totalCryptoPaid: 0,
      totalNairaPaid: 0,
    };

    return successResponse(res, 200, "Stats retrieved", {
      data: {
        totalTransactions,
        pending,
        processing,
        paid,
        rejected,
        totalCryptoPaid: sums.totalCryptoPaid,
        totalNairaPaid: sums.totalNairaPaid,
        totalUsers,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.getAllUsers = async (req, res, next) => {
  try {
    const users = await User.find({ role: "user" })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    return successResponse(res, 200, "Users retrieved", {
      count: users.length,
      data: users,
    });
  } catch (err) {
    next(err);
  }
};
