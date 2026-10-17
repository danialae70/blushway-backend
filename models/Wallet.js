// ============================================================
//  DANRIDES — models/Wallet.js
//  Driver prepaid balance + history of every top-up / commission
// ============================================================
const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    balance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const txSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['topup', 'commission'], required: true },
    amount: { type: Number, required: true }, // always a positive number
    balanceAfter: { type: Number, default: 0 },
    ride: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
    fare: { type: Number, default: 0 },
    pickup: { type: String, default: '' },
    dropoff: { type: String, default: '' },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

const Wallet = mongoose.models.Wallet || mongoose.model('Wallet', walletSchema);
const WalletTx = mongoose.models.WalletTx || mongoose.model('WalletTx', txSchema);

module.exports = { Wallet, WalletTx };