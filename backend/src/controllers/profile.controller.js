const bcrypt = require('bcryptjs');
const User = require('../models/user.model');
const cloudinary = require('../config/cloudinary');
const { successResponse, errorResponse } = require('../utils/apiResponse');

const USERNAME_REGEX = /^[a-z0-9_]{3,30}$/;
const MAX_PROFILE_IMAGE_SIZE = 5 * 1024 * 1024;

exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password -__v').lean();
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }
    return successResponse(res, 200, 'Success', { data: user });
  } catch (err) {
    console.error('getProfile error:', err);
    return errorResponse(res, 500, err.message || 'Failed to get profile');
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const { name, username, phone } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = String(name).trim();
    if (username !== undefined) {
      const raw = String(username).trim().toLowerCase();
      if (!USERNAME_REGEX.test(raw)) {
        return errorResponse(res, 400, 'Username must be 3–30 characters, lowercase letters, numbers and underscores only');
      }
      const existing = await User.findOne({ username: raw, _id: { $ne: req.user._id } });
      if (existing) {
        return errorResponse(res, 400, 'Username is already taken');
      }
      updates.username = raw;
    }
    if (phone !== undefined) updates.phone = String(phone).trim();

    if (Object.keys(updates).length === 0) {
      return errorResponse(res, 400, 'No valid fields to update');
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password -__v').lean();

    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }
    return successResponse(res, 200, 'Profile updated', { data: user });
  } catch (err) {
    console.error('updateProfile error:', err);
    if (err.name === 'ValidationError') {
      return errorResponse(res, 400, err.message || 'Validation failed');
    }
    return errorResponse(res, 500, err.message || 'Failed to update profile');
  }
};

exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return errorResponse(res, 400, 'Profile image is required');
    }
    if (req.file.size > MAX_PROFILE_IMAGE_SIZE) {
      return errorResponse(res, 400, 'Image must be under 5MB');
    }

    const user = await User.findById(req.user._id).select('+profileImagePublicId');
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    if (user.profileImagePublicId) {
      try {
        await cloudinary.uploader.destroy(user.profileImagePublicId);
      } catch (destroyErr) {
        console.error('Cloudinary destroy old image error:', destroyErr);
      }
    }

    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'naivolt/profiles',
      resource_type: 'image',
    });

    const profileImageUrl = result.secure_url || result.url;
    const profileImagePublicId = result.public_id;

    user.profileImageUrl = profileImageUrl;
    user.profileImagePublicId = profileImagePublicId;
    await user.save({ validateBeforeSave: false });

    const updated = await User.findById(req.user._id).select('-password -__v').lean();
    return successResponse(res, 200, 'Profile image updated', { data: updated });
  } catch (err) {
    console.error('uploadProfileImage error:', err);
    return errorResponse(res, 500, err.message || 'Failed to upload profile image');
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmNewPassword) {
      return errorResponse(res, 400, 'currentPassword, newPassword and confirmNewPassword are required');
    }
    if (newPassword.length < 6) {
      return errorResponse(res, 400, 'New password must be at least 6 characters');
    }
    if (newPassword !== confirmNewPassword) {
      return errorResponse(res, 400, 'New password and confirmation do not match');
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return errorResponse(res, 401, 'Current password is incorrect');
    }

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();

    return successResponse(res, 200, 'Password changed successfully');
  } catch (err) {
    console.error('changePassword error:', err);
    return errorResponse(res, 500, err.message || 'Failed to change password');
  }
};

exports.deleteAccount = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return errorResponse(res, 400, 'Password is required to deactivate account');
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return errorResponse(res, 401, 'Invalid password');
    }

    user.isActive = false;
    await user.save({ validateBeforeSave: false });

    return successResponse(res, 200, 'Account deactivated successfully');
  } catch (err) {
    console.error('deleteAccount error:', err);
    return errorResponse(res, 500, err.message || 'Failed to deactivate account');
  }
};

exports.savePushToken = async (req, res, next) => {
  try {
    const { pushToken } = req.body;
    if (!pushToken) return errorResponse(res, 400, 'pushToken is required');
    await User.findByIdAndUpdate(req.user._id, { pushToken });
    return successResponse(res, 200, 'Push token saved');
  } catch (err) {
    next(err);
  }
};
