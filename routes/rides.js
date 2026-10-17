// ============================================================
//  DANRIDES — routes/rides.js
// ============================================================
const express = require('express');
const router  = express.Router();
const Ride    = require('../models/Ride');
const Driver  = require('../models/Driver');
const auth    = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// ── Fare calculation helper ───────────────────────────────────
function calculateFare(distanceKm, rideType = 'standard') {
  const base   = { standard: 100, comfort: 150, premium: 200 };
  const perKm  = { standard:  25, comfort:  35, premium:  50 };
  return Math.round(base[rideType] + distanceKm * perKm[rideType]);
}

// ── Haversine distance ────────────────────────────────────────
function haversine([lng1, lat1], [lng2, lat2]) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── POST /api/rides/estimate ──────────────────────────────────
router.post('/estimate', auth, async (req, res) => {
  try {
    const { pickup, destination, rideType = 'standard' } = req.body;
    const distanceKm = haversine(pickup.coordinates, destination.coordinates);
    const estimatedFare = calculateFare(distanceKm, rideType);
    const estimatedMinutes = Math.round(distanceKm * 2.5);
    res.json({ success: true, distanceKm: distanceKm.toFixed(2), estimatedFare, estimatedMinutes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/rides/book ──────────────────────────────────────
router.post('/book', auth, [
  body('pickup.address').notEmpty(),
  body('pickup.coordinates').isArray(),
  body('destination.address').notEmpty(),
  body('destination.coordinates').isArray(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { pickup, destination, rideType = 'standard', paymentMethod = 'cash' } = req.body;
    const distanceKm = haversine(pickup.coordinates, destination.coordinates);
    const estimatedFare = calculateFare(distanceKm, rideType);

    // Find nearest available driver (2dsphere query)
    const nearbyDrivers = await Driver.find({
      isOnline: true,
      isAvailable: true,
      isVerified: true,
      isActive: true,
      'vehicle.type': { $in: [rideType, 'premium'] },
      currentLocation: {
        $near: {
          $geometry: { type: 'Point', coordinates: pickup.coordinates },
          $maxDistance: 10000   // 10 km
        }
      }
    }).limit(5).populate('user', 'name rating');

    const ride = await Ride.create({
      rider: req.user.id,
      pickup, destination, rideType,
      estimatedFare, distance: distanceKm,
      paymentMethod,
      status: nearbyDrivers.length > 0 ? 'searching' : 'searching',
    });

    res.status(201).json({ success: true, ride, nearbyDrivers: nearbyDrivers.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/rides/:id ────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
      .populate('rider', 'name phone avatar rating')
      .populate({ path: 'driver', populate: { path: 'user', select: 'name phone avatar rating' }});
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
    res.json({ success: true, ride });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/rides/history/me ─────────────────────────────────
router.get('/history/me', auth, async (req, res) => {
  try {
    const page  = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const rides = await Ride.find({ rider: req.user.id, status: 'completed' })
      .sort({ completedAt: -1 })
      .skip((page - 1) * limit).limit(limit)
      .populate({ path: 'driver', populate: { path: 'user', select: 'name avatar' }});
    const total = await Ride.countDocuments({ rider: req.user.id, status: 'completed' });
    res.json({ success: true, rides, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/rides/:id/cancel ───────────────────────────────
router.patch('/:id/cancel', auth, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
    if (['completed','cancelled'].includes(ride.status))
      return res.status(400).json({ success: false, message: 'Cannot cancel this ride' });

    ride.status = 'cancelled';
    ride.cancelledBy = req.body.cancelledBy || 'rider';
    ride.cancellationReason = req.body.reason || '';
    await ride.save();
    res.json({ success: true, ride });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/rides/:id/rate ──────────────────────────────────
router.post('/:id/rate', auth, async (req, res) => {
  try {
    const { rating, review } = req.body;
    const ride = await Ride.findById(req.params.id);
    if (!ride || ride.status !== 'completed')
      return res.status(400).json({ success: false, message: 'Can only rate completed rides' });

    if (ride.rider.toString() === req.user.id) {
      ride.driverRating = rating;
      ride.driverReview = review || '';
    } else {
      ride.riderRating = rating;
      ride.riderReview = review || '';
    }
    await ride.save();
    res.json({ success: true, message: 'Rating submitted 🌸' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/rides/:id/sos ───────────────────────────────────
router.post('/:id/sos', auth, async (req, res) => {
  try {
    const ride = await Ride.findByIdAndUpdate(req.params.id, {
      sosTriggered: true, sosTime: new Date()
    }, { new: true });
    // In production: call emergency services API, notify contacts
    console.log(`🚨 SOS Alert: Ride ${req.params.id} — Rider ${req.user.id}`);
    res.json({ success: true, message: 'SOS triggered! Help is on the way. 🌸' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
