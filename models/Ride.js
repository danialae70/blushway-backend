// ============================================================
//  DANRIDES — models/Ride.js
// ============================================================
const mongoose = require('mongoose');

const rideSchema = new mongoose.Schema({
  rider:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  pickup: {
    address:     { type: String, required: true },
    coordinates: { type: [Number], required: true }   // [lng, lat]
  },
  destination: {
    address:     { type: String, required: true },
    coordinates: { type: [Number], required: true }
  },

  rideType: { type: String, enum: ['scooty', 'mini', 'ac', 'standard', 'comfort', 'premium'], default: 'mini' },

  // Fare (worked out by the server)
  fare:          { type: Number, required: true },
  estimatedFare: { type: Number, default: 0 },
  finalFare:     { type: Number, default: null },
  currency:      { type: String, default: 'PKR' },
  distanceKm:    { type: Number, default: 0 },
  durationMin:   { type: Number, default: 0 },
  commission:    { type: Number, default: 0 },
  driverEarning: { type: Number, default: 0 },

  // Driver's live position (what the passenger sees on the map)
  driverLocation: {
    lat:       { type: Number, default: null },
    lng:       { type: Number, default: null },
    updatedAt: { type: Date,   default: null },
  },

  status: {
    type: String,
    enum: ['requested', 'accepted', 'in_progress', 'completed', 'cancelled'],
    default: 'requested'
  },
  cancelledBy:        { type: String, enum: ['rider', 'driver', 'system', null], default: null },
  cancellationReason: { type: String, default: '' },

  requestedAt: { type: Date, default: Date.now },
  acceptedAt:  { type: Date, default: null },
  startedAt:   { type: Date, default: null },
  completedAt: { type: Date, default: null },
  declinedBy:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  paymentMethod: { type: String, enum: ['cash', 'card', 'wallet'], default: 'cash' },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'refunded'], default: 'pending' },
  paymentId:     { type: String, default: '' },

  riderRating:  { type: Number, default: null },
  driverRating: { type: Number, default: null },
  riderReview:  { type: String, default: '' },
  driverReview: { type: String, default: '' },

  routeTaken: { type: [[Number]], default: [] },

  sosTriggered: { type: Boolean, default: false },
  sosTime:      { type: Date, default: null },
}, { timestamps: true });

rideSchema.index({ rider: 1, status: 1 });
rideSchema.index({ driver: 1, status: 1 });
rideSchema.index({ status: 1, requestedAt: -1 });

module.exports = mongoose.model('Ride', rideSchema);