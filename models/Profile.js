const mongoose = require('mongoose');

// Extra data per user: driver approval (KYC) + emergency contacts
const profileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    driverStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
    cnicNumber: { type: String, default: '' },
    selfieFile: { type: String, default: '' },
    cnicFile: { type: String, default: '' },
    kycNote: { type: String, default: '' },
    submittedAt: { type: Date, default: null },
    emergencyContacts: [{ name: String, phone: String, _id: false }],
  },
  { timestamps: true }
);

module.exports = mongoose.models.Profile || mongoose.model('Profile', profileSchema);
