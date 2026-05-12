const express = require("express");
const { protect } = require("../middleware/auth.middleware");
const adminMiddleware = require("../middleware/admin.middleware");
const {
  getAllTransactions,
  getTransactionById,
  approveTransaction,
  rejectTransaction,
  getAdminStats,
  getAllUsers,
} = require("../controllers/admin.controller");
const {
  addWalletAddresses,
  listWalletAddresses,
  releaseWalletAddress,
  deleteWalletAddress,
} = require("../controllers/depositAddress.controller");
const {
  createCategory,
  updateCategory,
  deleteCategory,
  getAllCategories,
  getAllGiftCardTransactions,
  getGiftCardTransactionById: getGiftCardTxById,
  approveGiftCardTransaction,
  rejectGiftCardTransaction,
} = require("../controllers/adminGiftCard.controller");

const router = express.Router();

router.use(protect, adminMiddleware);

router.get("/transactions", getAllTransactions);
router.get("/transactions/:id", getTransactionById);
router.patch("/transactions/:id/approve", approveTransaction);
router.patch("/transactions/:id/reject", rejectTransaction);
router.get("/stats", getAdminStats);
router.get("/users", getAllUsers);

// Wallet address pool management
router.post("/wallet-addresses", addWalletAddresses);
router.get("/wallet-addresses", listWalletAddresses);
router.patch("/wallet-addresses/:id/release", releaseWalletAddress);
router.delete("/wallet-addresses/:id", deleteWalletAddress);

// Gift card category management
router.post("/gift-card-categories", createCategory);
router.get("/gift-card-categories", getAllCategories);
router.put("/gift-card-categories/:id", updateCategory);
router.delete("/gift-card-categories/:id", deleteCategory);

// Gift card transaction management
router.get("/gift-card-transactions", getAllGiftCardTransactions);
router.get("/gift-card-transactions/:id", getGiftCardTxById);
router.patch("/gift-card-transactions/:id/approve", approveGiftCardTransaction);
router.patch("/gift-card-transactions/:id/reject", rejectGiftCardTransaction);

module.exports = router;
