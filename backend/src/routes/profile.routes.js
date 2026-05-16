const express = require('express');
const { protect } = require('../middleware/auth.middleware');
const { getProfile, updateProfile, uploadProfileImage, changePassword, deleteAccount, savePushToken } = require('../controllers/profile.controller');
const upload = require('../middleware/upload.middleware');

const router = express.Router();

router.get('/', protect, getProfile);
// Specific routes before generic '/' so PATCH /profile/password and /profile/image are not caught by updateProfile
router.patch('/password', protect, changePassword);
router.patch('/image', protect, upload.uploadProfileImage, uploadProfileImage);
router.patch('/push-token', protect, savePushToken);
router.patch('/', protect, updateProfile);
router.delete('/', protect, deleteAccount);

module.exports = router;
