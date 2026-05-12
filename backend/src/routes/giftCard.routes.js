const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const upload = require('../middleware/upload.middleware');
const {
  getCategories,
  submitGiftCard,
  getMyGiftCardTransactions,
  getGiftCardTransactionById,
} = require('../controllers/giftCard.controller');

router.get('/categories', protect, getCategories);
router.post('/transactions', protect, upload.single('proofImage'), submitGiftCard);
router.get('/transactions', protect, getMyGiftCardTransactions);
router.get('/transactions/:id', protect, getGiftCardTransactionById);

module.exports = router;
