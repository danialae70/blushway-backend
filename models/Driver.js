// ============================================================
//  DANRIDES — models/Driver.js
// ============================================================
const mongoose = require('mongoose');

const driverSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  // Vehicle
  vehicle: {
    make:         { type: String, required: true },   // Toyota
    model:        { type: String, required: true },   // Corolla
    year:         { type: Number, required: true },
    color:        { type: String, required: true },
    licensePlate: { type: String, required: true, unique: true },
    type:         { type: String, enum: ['standard','comfort','premium'], default: 'standard' },
  },

  // Documents
  documents: {
    cnic:            { url: String, verified: { type: Boolean, default: false } },
    drivingLicense:  { url: String, verified: { type: Boolean, default: false } },
    vehicleReg:      { url: String, verified: { type: Boolean, default: false } },
    backgroundCheck: { url: String, verified: { type: Boolean, default: false } },
  },

  // Live status
  isOnline:     { type: Boolean, default: false },
  isAvailable:  { type: Boolean, default: false },
  currentLocation: {
    type:        { type: String, default: 'Point' },
    coordinates: { type: [Number], default: [0, 0] }   // [lng, lat]
  },

  // Stats
  rating:         { type: Number, default: 5.0 },
  totalTrips:     { type: Number, default: 0 },
  totalEarnings:  { type: Number, default: 0 },
  todayEarnings:  { type: Number, default: 0 },
  acceptanceRate: { type: Number, default: 100 },

  isVerified: { type: Boolean, default: false },
  isActive:   { type: Boolean, default: false },   // Admin approves

}, { timestamps: true });

driverSchema.index({ currentLocation: '2dsphere' });

module.exports = mongoose.model('Driver', driverSchema);
