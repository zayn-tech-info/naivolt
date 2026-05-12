const WalletAddress = require('../models/walletAddress.model');
const { successResponse, errorResponse } = require('../utils/apiResponse');

// User: get a unique deposit address for a coin
exports.requestDepositAddress = async (req, res) => {
  try {
    const coin = String(req.query.coin || '').toUpperCase();
    if (!coin) return errorResponse(res, 400, 'coin query param is required');

    const wallet = await WalletAddress.findOneAndUpdate(
      { coin, isAvailable: true },
      { isAvailable: false, assignedAt: new Date() },
      { new: true, sort: { createdAt: 1 } } // oldest first (FIFO)
    );

    if (!wallet) {
      return errorResponse(res, 503, `No deposit address available for ${coin} right now. Please try again shortly or contact support.`);
    }

    return successResponse(res, 200, 'Deposit address assigned', {
      data: {
        addressId: wallet._id,
        coin: wallet.coin,
        network: wallet.network,
        address: wallet.address,
      },
    });
  } catch (err) {
    console.error('requestDepositAddress error:', err);
    return errorResponse(res, 500, 'Failed to assign deposit address');
  }
};

// Admin: add one or many addresses to the pool
exports.addWalletAddresses = async (req, res) => {
  try {
    const { coin, network, addresses } = req.body;
    if (!coin || !network || !Array.isArray(addresses) || addresses.length === 0) {
      return errorResponse(res, 400, 'coin, network, and addresses[] are required');
    }

    const docs = addresses.map((address) => ({
      coin: String(coin).toUpperCase().trim(),
      network: String(network).trim(),
      address: String(address).trim(),
      isAvailable: true,
    }));

    // insertMany with ordered:false so it skips duplicates and continues
    const result = await WalletAddress.insertMany(docs, { ordered: false }).catch((err) => {
      if (err.code === 11000) return err.result; // partial insert — duplicates skipped
      throw err;
    });

    const inserted = result?.insertedCount ?? result?.length ?? 0;
    return successResponse(res, 201, `${inserted} address(es) added`, { inserted });
  } catch (err) {
    console.error('addWalletAddresses error:', err);
    return errorResponse(res, 500, 'Failed to add wallet addresses');
  }
};

// Admin: list all addresses (optionally filter by coin / availability)
exports.listWalletAddresses = async (req, res) => {
  try {
    const filter = {};
    if (req.query.coin) filter.coin = String(req.query.coin).toUpperCase();
    if (req.query.available !== undefined) filter.isAvailable = req.query.available === 'true';

    const addresses = await WalletAddress.find(filter)
      .sort({ coin: 1, isAvailable: -1, createdAt: 1 })
      .populate('assignedTo', 'amountCrypto amountNaira status createdAt')
      .lean();

    return successResponse(res, 200, 'Wallet addresses retrieved', {
      count: addresses.length,
      data: addresses,
    });
  } catch (err) {
    return errorResponse(res, 500, 'Failed to list wallet addresses');
  }
};

// Admin: release an address back to the pool
exports.releaseWalletAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const wallet = await WalletAddress.findByIdAndUpdate(
      id,
      { isAvailable: true, assignedTo: null, assignedAt: null },
      { new: true }
    );
    if (!wallet) return errorResponse(res, 404, 'Wallet address not found');
    return successResponse(res, 200, 'Address released', { data: wallet });
  } catch (err) {
    return errorResponse(res, 500, 'Failed to release address');
  }
};

// Admin: delete an address from the pool
exports.deleteWalletAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const wallet = await WalletAddress.findByIdAndDelete(id);
    if (!wallet) return errorResponse(res, 404, 'Wallet address not found');
    return successResponse(res, 200, 'Address deleted');
  } catch (err) {
    return errorResponse(res, 500, 'Failed to delete address');
  }
};
