const mongoose = require('mongoose');

const sosSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ride: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
    token: { type: String, unique: true, index: true }, // secret for the live-location link
    lat: Number,
    lng: Number,
    status: { type: String, enum: ['active', 'resolved'], default: 'active' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.SOSAlert || mongoose.model('SOSAlert', sosSchema);
