const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const { successResponse, errorResponse } = require("../utils/apiResponse");

// Includes role so client can route admin vs user after login/register.
function toUserPayload(user) {
  return {
    id: user._id,
    _id: user._id,
    name: user.name,
    username: user.username,
    email: user.email,
    phone: user.phone,
    role: user.role,
  };
}

exports.register = async (req, res, next) => {
  try {
    const { name, username, email, phone, password } = req.body;

    const user = await User.create({ name, username, email, phone, password });

  const token = user.generateToken();

    return successResponse(res, 201, "Account created", {
      token,
      user: toUserPayload(user),
    });
  } catch (err) {
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findByEmail(email, { select: "+password" });
    if (!user) {
      return errorResponse(res, 401, "Invalid email or password");
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return errorResponse(res, 401, "Invalid email or password");
    }

    const token = user.generateToken();
    return successResponse(res, 200, "Logged in", {
      token,
      user: toUserPayload(user),
    });
  } catch (err) {
    next(err);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    return successResponse(res, 200, "Success", {
      user: toUserPayload(req.user),
    });
  } catch (err) {
    next(err);
  }
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return errorResponse(res, 400, 'Email is required');

    const user = await User.findByEmail(email);
    // Don't reveal whether email is registered
    if (!user) {
      return successResponse(res, 200, 'If that email is registered, a reset code has been sent.');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await User.findByIdAndUpdate(user._id, {
      resetOtp: otp,
      resetOtpExpiry: new Date(Date.now() + 15 * 60 * 1000),
    });

    // In production, send email here
    const isDev = process.env.NODE_ENV !== 'production';
    return successResponse(res, 200, 'Reset code sent', isDev ? { otp } : {});
  } catch (err) {
    next(err);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return errorResponse(res, 400, 'Email, code, and new password are required');
    }
    if (newPassword.length < 6) {
      return errorResponse(res, 400, 'Password must be at least 6 characters');
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+resetOtp +resetOtpExpiry +password');
    if (!user || !user.resetOtp) {
      return errorResponse(res, 400, 'Invalid or expired reset code');
    }
    if (user.resetOtp !== String(otp)) {
      return errorResponse(res, 400, 'Incorrect reset code');
    }
    if (user.resetOtpExpiry < new Date()) {
      return errorResponse(res, 400, 'Reset code has expired — request a new one');
    }

    user.password = newPassword;
    user.resetOtp = undefined;
    user.resetOtpExpiry = undefined;
    await user.save();

    return successResponse(res, 200, 'Password reset successfully. You can now log in.');
  } catch (err) {
    next(err);
  }
};
