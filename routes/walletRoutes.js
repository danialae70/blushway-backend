const express = require('express');
const protect = require('../middleware/auth');
const User = require('../models/User');
const { Wallet, WalletTx } = require('../models/Wallet');

const router = express.Router();

const fail = (res, err, label) => {
  console.error(`[wallet] ${label}:`, err);
  return res
    .status(500)
    .json({ success: false, message: 'Something went wrong. Please try again.' });
};

const requireAdmin = (req, res, next) =>
  req.user?.role === 'admin'
    ? next()
    : res.status(403).json({ success: false, message: 'Admin access only.' });

const requireDriver = (req, res, next) =>
  req.user?.role === 'driver'
    ? next()
    : res.status(403).json({ success: false, message: 'Driver access only.' });

// GET /api/wallet/me  (driver sees own balance + history)
router.get('/me', protect, requireDriver, async (req, res) => {
  try {
    const [wallet, transactions, completedRides] = await Promise.all([
      Wallet.findOne({ user: req.user._id }).lean(),
      WalletTx.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(),
      WalletTx.countDocuments({ user: req.user._id, type: 'commission' }),
    ]);
    return res.json({
      success: true,
      balance: wallet?.balance || 0,
      completedRides,
      transactions,
    });
  } catch (err) {
    return fail(res, err, 'me');
  }
});

// POST /api/wallet/topup  (admin adds money after the driver paid you)
router.post('/topup', protect, requireAdmin, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const amount = Number(req.body.amount);

    if (!email) {
      return res.status(400).json({ success: false, message: 'Enter the driver email.' });
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      return res.status(400).json({ success: false, message: 'Enter a valid amount.' });
    }

    const safeEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const driver = await User.findOne({
      email: { $regex: new RegExp('^' + safeEmail + '$', 'i') },
      role: 'driver',
    });
    if (!driver) {
      return res
        .status(404)
        .json({ success: false, message: 'No driver account found with that email.' });
    }

    const wallet = await Wallet.findOneAndUpdate(
      { user: driver._id },
      { $inc: { balance: amount } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    await WalletTx.create({
      user: driver._id,
      type: 'topup',
      amount,
      balanceAfter: wallet.balance,
      note: 'Top-up added by admin',
    });

    return res.json({
      success: true,
      balance: wallet.balance,
      driver: { name: driver.name, email: driver.email },
    });
  } catch (err) {
    return fail(res, err, 'topup');
  }
});

// GET /api/wallet/admin/summary  (admin dashboard)
router.get('/admin/summary', protect, requireAdmin, async (req, res) => {
  try {
    const [drivers, wallets, earnings, recent] = await Promise.all([
      User.find({ role: 'driver' }).select('name email phone').lean(),
      Wallet.find().lean(),
      WalletTx.aggregate([
        { $match: { type: 'commission' } },
        { $group: { _id: null, total: { $sum: '$amount' }, rides: { $sum: 1 } } },
      ]),
      WalletTx.find().sort({ createdAt: -1 }).limit(30).populate('user', 'name email').lean(),
    ]);

    const balances = new Map(wallets.map((w) => [String(w.user), w.balance]));
    const list = drivers.map((d) => ({
      _id: d._id,
      name: d.name,
      email: d.email,
      phone: d.phone,
      balance: balances.get(String(d._id)) || 0,
    }));

    return res.json({
      success: true,
      drivers: list,
      companyEarnings: earnings[0]?.total || 0,
      completedRides: earnings[0]?.rides || 0,
      owedToDrivers: list.reduce((sum, d) => sum + d.balance, 0),
      recent,
    });
  } catch (err) {
    return fail(res, err, 'summary');
  }
});

module.exports = router;