const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requestDepositAddress } = require('../controllers/depositAddress.controller');

// Authenticated users request a unique deposit address
router.get('/', protect, requestDepositAddress);

module.exports = router;
