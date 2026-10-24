const mongoose = require('mongoose');

const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model });

// In-app chat between the rider and the driver of one ride
const rideMessageSchema = new mongoose.Schema(
  {
    ride: { ...ref('Ride'), required: true, index: true },
    author: { ...ref('User'), required: true },
    text: { type: String, required: true },
  },
  { timestamps: true }
);

// What the passenger sees about the driver's vehicle
const vehicleSchema = new mongoose.Schema(
  {
    user: { ...ref('User'), required: true, unique: true },
    vehicleType: { type: String, enum: ['scooty', 'mini', 'ac'], required: true },
    model: { type: String, default: '' },
    color: { type: String, default: '' },
    plate: { type: String, default: '' },
  },
  { timestamps: true }
);

// One-time code for "forgot password" (deleted automatically when it expires)
const resetSchema = new mongoose.Schema({
  user: { ...ref('User'), required: true, unique: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});
resetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  RideMessage: mongoose.models.RideMessage || mongoose.model('RideMessage', rideMessageSchema),
  Vehicle: mongoose.models.Vehicle || mongoose.model('Vehicle', vehicleSchema),
  PasswordReset: mongoose.models.PasswordReset || mongoose.model('PasswordReset', resetSchema),
};
