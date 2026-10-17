// ============================================================
//  DANRIDES — models/User.js
// ============================================================
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  email:    { type: String, required: true, unique: true, lowercase: true },
  phone:    { type: String, required: true },
  password: { type: String, required: true, minlength: 6, select: false },
  role:     { type: String, enum: ['rider','driver','admin'], default: 'rider' },

  avatar:    { type: String, default: '' },
  rating:    { type: Number, default: 5.0 },
  rideCount: { type: Number, default: 0 },

  // Safety
  emergencyContacts: [{
    name:  String,
    phone: String,
  }],
  shareTripLive: { type: Boolean, default: true },

  // Payment
  savedCards:  [{ cardId: String, last4: String, brand: String }],
  walletBalance: { type: Number, default: 0 },

  isVerified: { type: Boolean, default: false },
  isActive:   { type: Boolean, default: true },
  lastSeen:   { type: Date, default: Date.now },

  fcmToken:   { type: String, default: '' },   // push notifications

}, { timestamps: true });

// ── Hash password before save ─────────────────────────────────
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// ── Compare password ─────────────────────────────────────────
userSchema.methods.comparePassword = async function(candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('User', userSchema);
