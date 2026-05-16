const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^(07|08|09)\d{9}$/;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      lowercase: true,
      trim: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [30, 'Username must be at most 30 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [EMAIL_REGEX, 'Please provide a valid email'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select: false,
    },
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      trim: true,
      match: [PHONE_REGEX, 'Please provide a valid Nigerian phone number (e.g. 08012345678)'],
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    profileImageUrl: {
      type: String,
      default: null,
    },
    profileImagePublicId: {
      type: String,
      default: null,
    },
    pushToken: {
      type: String,
      default: null,
    },
    resetOtp: { type: String, default: null, select: false },
    resetOtpExpiry: { type: Date, default: null, select: false },
    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { versionKey: false }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function (userPassword) {
  if (!this.password) return false;
  return bcrypt.compare(userPassword, this.password);
};

userSchema.methods.generateToken = function () {
  return jwt.sign(
    {
      id: this._id,
      role: this.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || "30d",
    },
  );
};

userSchema.statics.findByEmail = function (email, options = {}) {
  const normalized = typeof email === 'string' ? email.toLowerCase().trim() : '';
  const q = this.findOne({ email: normalized });
  return options.select ? q.select(options.select) : q;
};

const User = mongoose.model('User', userSchema);
module.exports = User;
