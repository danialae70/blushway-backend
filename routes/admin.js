// Re-exports admin router from users.js (combined file)
// In production separate into its own file
const { Router } = require('express');
const r = Router();
const User   = require('../models/User');
const Driver = require('../models/Driver');
const Ride   = require('../models/Ride');
const auth   = require('../middleware/auth');

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
  next();
};

r.use(auth, requireAdmin);

r.get('/stats', async (req, res) => {
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

r.patch('/drivers/:id/verify', async (req, res) => {
  try {
    const driver = await Driver.findByIdAndUpdate(req.params.id, { isVerified: true, isActive: true }, { new: true });
    res.json({ success: true, driver });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

r.get('/drivers/pending', async (req, res) => {
  try {
    const drivers = await Driver.find({ isVerified: false }).populate('user','name email phone');
    res.json({ success: true, drivers });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = r;
