// ============================================================
//  DANRIDES — routes/users.js
// ============================================================
const express = require('express');
const router  = express.Router();
const User    = require('../models/User');
const auth    = require('../middleware/auth');

router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/profile', auth, async (req, res) => {
  try {
    const allowed = ['name','phone','avatar','emergencyContacts','shareTripLive','fcmToken'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true, runValidators: true }).select('-password');
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id).select('+password');
    if (!(await user.comparePassword(currentPassword)))
      return res.status(400).json({ success: false, message: 'Wrong current password' });
    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: 'Password updated 🌸' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;

// ============================================================
//  DANRIDES — routes/admin.js
// ============================================================
// (Separate file in real project — combined here for brevity)
const adminRouter = express.Router();
const Driver = require('../models/Driver');
const Ride   = require('../models/Ride');

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
  next();
};

adminRouter.use(auth, requireAdmin);

// Dashboard stats
adminRouter.get('/stats', async (req, res) => {
  try {
    const [users, drivers, rides, revenue] = await Promise.all([
      User.countDocuments({ role: 'rider' }),
      Driver.countDocuments({ isVerified: true }),
      Ride.countDocuments({ status: 'completed' }),
      Ride.aggregate([{ $match:{ status:'completed' }},{ $group:{ _id:null, total:{ $sum:'$finalFare' }}}])
    ]);
    res.json({ success: true, stats: { users, drivers, rides, revenue: revenue[0]?.total || 0 }});
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Verify driver
adminRouter.patch('/drivers/:id/verify', async (req, res) => {
  try {
    const driver = await Driver.findByIdAndUpdate(req.params.id, { isVerified: true, isActive: true }, { new: true });
    res.json({ success: true, driver });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// List pending drivers
adminRouter.get('/drivers/pending', async (req, res) => {
  try {
    const drivers = await Driver.find({ isVerified: false }).populate('user','name email phone');
    res.json({ success: true, drivers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Suspend user
adminRouter.patch('/users/:id/suspend', async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true, message: 'User suspended' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = adminRouter;
