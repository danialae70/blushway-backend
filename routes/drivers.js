// ============================================================
//  DANRIDES — routes/drivers.js
// ============================================================
const express = require('express');
const router  = express.Router();
const Driver  = require('../models/Driver');
const Ride    = require('../models/Ride');
const auth    = require('../middleware/auth');

// ── POST /api/drivers/register ────────────────────────────────
router.post('/register', auth, async (req, res) => {
  try {
    const existing = await Driver.findOne({ user: req.user.id });
    if (existing) return res.status(409).json({ success: false, message: 'Driver profile exists' });
    const driver = await Driver.create({ user: req.user.id, ...req.body });
    res.status(201).json({ success: true, driver });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/drivers/me ───────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id }).populate('user', 'name email phone avatar');
    if (!driver) return res.status(404).json({ success: false, message: 'Driver profile not found' });
    res.json({ success: true, driver });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/drivers/location ───────────────────────────────
router.patch('/location', auth, async (req, res) => {
  try {
    const { lng, lat } = req.body;
    await Driver.findOneAndUpdate({ user: req.user.id }, {
      currentLocation: { type: 'Point', coordinates: [lng, lat] }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/drivers/status ─────────────────────────────────
router.patch('/status', auth, async (req, res) => {
  try {
    const { isOnline, isAvailable } = req.body;
    const driver = await Driver.findOneAndUpdate({ user: req.user.id }, { isOnline, isAvailable }, { new: true });
    res.json({ success: true, driver });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/drivers/:rideId/accept ────────────────────────
router.patch('/:rideId/accept', auth, async (req, res) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id });
    const ride   = await Ride.findOneAndUpdate(
      { _id: req.params.rideId, status: 'searching' },
      { driver: driver._id, status: 'driver_assigned', assignedAt: new Date() },
      { new: true }
    ).populate('rider', 'name phone avatar');
    if (!ride) return res.status(409).json({ success: false, message: 'Ride no longer available' });
    await Driver.findByIdAndUpdate(driver._id, { isAvailable: false });
    res.json({ success: true, ride });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/drivers/earnings ─────────────────────────────────
router.get('/earnings', auth, async (req, res) => {
  try {
    const driver = await Driver.findOne({ user: req.user.id });
    const today  = new Date(); today.setHours(0,0,0,0);
    const rides  = await Ride.find({ driver: driver._id, status: 'completed', completedAt: { $gte: today } });
    const todayEarnings = rides.reduce((sum, r) => sum + (r.finalFare || r.estimatedFare), 0);
    res.json({ success: true, todayEarnings, tripCount: rides.length, totalEarnings: driver.totalEarnings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
