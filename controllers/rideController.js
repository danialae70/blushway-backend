const mongoose = require('mongoose');
const Ride = require('../models/Ride');
const { Wallet, WalletTx } = require('../models/Wallet');
const User = require('../models/User');
const Profile = require('../models/Profile');
const { Vehicle } = require('../models/ExtraModels');
const { trip, fareFor, CATS } = require('../utils/fare');
const { rideCard } = require('../utils/rideCard');

const PERSON_FIELDS = 'name rating';
const ACTIVE_STATUSES = ['accepted', 'in_progress'];
const REQUEST_TTL_MS = 10 * 60 * 1000; // unaccepted requests expire after 10 minutes
const freshSince = () => new Date(Date.now() - REQUEST_TTL_MS);

// Cancel history, used for the "3 give-backs in a day" rules
const CancelLog = mongoose.models.CancelLog || mongoose.model('CancelLog', new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  role: String,
  ride: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride' },
  reason: String,
}, { timestamps: true }));

const REASONS = ['Changed my plans', 'Driver is too far', 'Waiting too long', 'Found another ride',
  'Passenger not at pickup', 'Vehicle problem', 'Pickup is too far', 'Wrong destination', 'Safety concern', 'Other'];
const cleanReason = (v) => (REASONS.includes(v) ? v : 'Other');
const DAY_MS = 24 * 60 * 60 * 1000;

// Company keeps 30% of every fare (cash rides)
const COMMISSION_RATE = 0.3;
const commissionFor = (fare) => Math.round(Number(fare || 0) * COMMISSION_RATE);

const serverError = (res, err, label) => {
  console.error(`[rides] ${label}:`, err);
  return res
    .status(500)
    .json({ success: false, message: 'Something went wrong. Please try again.' });
};

// ---------------------------------------------------------------------------
// RIDER
// ---------------------------------------------------------------------------

// POST /api/rides/book
exports.bookRide = async (req, res) => {
  try {
    const { pickup, destination } = req.body;
    const rideType = CATS[req.body.rideType] ? req.body.rideType : 'mini';

    const existing = await Ride.findOne({
      rider: req.user._id,
      $or: [
        { status: { $in: ACTIVE_STATUSES } },
        { status: 'requested', requestedAt: { $gte: freshSince() } },
      ],
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active ride request.',
        ride: existing,
      });
    }

    const from = pickup.coordinates.map(Number);
    const to = destination.coordinates.map(Number);
    const { km, minutes } = await trip(from, to);

    const ride = await Ride.create({
      rider: req.user._id,
      pickup: { address: String(pickup.address).slice(0, 200), coordinates: from },
      destination: { address: String(destination.address).slice(0, 200), coordinates: to },
      distanceKm: Number(km.toFixed(1)),
      durationMin: Math.max(1, Math.round(minutes)),
      rideType,
      fare: fareFor(rideType, km, minutes), // never trust the phone's fare
    });

    // Send the new request to every approved online driver
    const io = req.app.get('io');
    if (io) {
      const rider = await User.findById(req.user._id).select('name').lean();
      io.to('drivers').emit('new-ride-request', rideCard(ride, rider && rider.name));
    }

    return res.status(201).json({ success: true, ride });
  } catch (err) {
    return serverError(res, err, 'bookRide');
  }
};

// PATCH /api/rides/:id/cancel  (before pickup)
exports.cancelRide = async (req, res) => {
  try {
    const before = await Ride.findOne({
      _id: req.params.id, rider: req.user._id, status: { $in: ['requested', 'accepted'] },
    });
    if (!before) {
      return res.status(409).json({ success: false, message: 'This ride cannot be cancelled.' });
    }
    const reason = cleanReason(req.body && req.body.reason);
    const ride = await Ride.findOneAndUpdate(
      { _id: before._id, status: before.status },
      { status: 'cancelled', cancelledBy: 'rider', cancellationReason: reason },
      { new: true }
    );
    if (!ride) {
      return res.status(409).json({ success: false, message: 'This ride cannot be cancelled.' });
    }

    let warning = null;
    if (before.status === 'accepted') {
      await CancelLog.create({ user: req.user._id, role: 'rider', ride: ride._id, reason });
      const n = await CancelLog.countDocuments({
        user: req.user._id, role: 'rider', createdAt: { $gte: new Date(Date.now() - DAY_MS) },
      });
      if (n >= 3) {
        warning = `You have cancelled ${n} accepted rides in the last 24 hours. Please only book when you are ready to ride.`;
      }
    }
    return res.json({ success: true, ride, warning });
  } catch (err) {
    return serverError(res, err, 'cancelRide');
  }
};

// GET /api/rides/history
exports.getHistory = async (req, res) => {
  try {
    const rides = await Ride.find({
      $or: [{ rider: req.user._id }, { driver: req.user._id }],
      status: 'completed',
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('driver', PERSON_FIELDS)
      .lean();
    return res.json({ success: true, rides });
  } catch (err) {
    return serverError(res, err, 'getHistory');
  }
};

// GET /api/rides/:id  (rider or assigned driver only)
exports.getRideById = async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
      .populate('rider', PERSON_FIELDS)
      .populate('driver', PERSON_FIELDS);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found.' });

    const uid = String(req.user._id);
    const isRider = String(ride.rider?._id) === uid;
    const isDriver = String(ride.driver?._id) === uid;
    if (!isRider && !isDriver) {
      return res.status(403).json({ success: false, message: 'Not allowed.' });
    }

    return res.json({ success: true, ride });
  } catch (err) {
    return serverError(res, err, 'getRideById');
  }
};

// ---------------------------------------------------------------------------
// DRIVER
// ---------------------------------------------------------------------------

// GET /api/rides/requests
exports.getRideRequests = async (req, res) => {
  try {
    const rides = await Ride.find({
      status: 'requested',
      driver: null,
      rider: { $ne: req.user._id },
      declinedBy: { $ne: req.user._id },
      requestedAt: { $gte: freshSince() },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('rider', PERSON_FIELDS)
      .lean();

    return res.json({ success: true, rides });
  } catch (err) {
    return serverError(res, err, 'getRideRequests');
  }
};

// GET /api/rides/driver/active
exports.getActiveDriverRide = async (req, res) => {
  try {
    const ride = await Ride.findOne({
      driver: req.user._id,
      status: { $in: ACTIVE_STATUSES },
    }).populate('rider', PERSON_FIELDS);

    return res.json({ success: true, ride });
  } catch (err) {
    return serverError(res, err, 'getActiveDriverRide');
  }
};

// PATCH /api/rides/:id/accept
// Driver must have enough prepaid balance to cover the 30% company share.
exports.acceptRide = async (req, res) => {
  try {
    const busy = await Ride.exists({
      driver: req.user._id,
      status: { $in: ACTIVE_STATUSES },
    });
    if (busy) {
      return res
        .status(409)
        .json({ success: false, message: 'Finish your current ride first.' });
    }

    const gaveBack = await CancelLog.find({
      user: req.user._id, role: 'driver', createdAt: { $gte: new Date(Date.now() - DAY_MS) },
    }).sort({ createdAt: -1 }).limit(3).lean();
    if (gaveBack.length >= 3) {
      const waitMs = new Date(gaveBack[0].createdAt).getTime() + 60 * 60 * 1000 - Date.now();
      if (waitMs > 0) {
        return res.status(403).json({
          success: false,
          message: `You gave back 3 rides today. You can accept new rides again in ${Math.ceil(waitMs / 60000)} minutes.`,
        });
      }
    }

    if (!(await Vehicle.exists({ user: req.user._id }))) {
      return res.status(403).json({
        success: false,
        message: 'Please add your vehicle details (type, model, color and number plate) on your driver home page first.',
      });
    }

    const prof = await Profile.findOne({ user: req.user._id }).select('driverStatus').lean();
    if (!prof || prof.driverStatus !== 'approved') {
      return res.status(403).json({ success: false, message: 'Your driver account is not approved yet.' });
    }

    const target = await Ride.findOne({
      _id: req.params.id,
      status: 'requested',
      driver: null,
    }).select('fare');
    if (!target) {
      return res
        .status(409)
        .json({ success: false, message: 'This ride is no longer available.' });
    }

    const needed = commissionFor(target.fare);
    const wallet = await Wallet.findOne({ user: req.user._id }).lean();
    const balance = wallet?.balance || 0;
    if (balance < needed) {
      return res.status(402).json({
        success: false,
        message: `Your balance is Rs ${balance}. You need at least Rs ${needed} to take this ride. Please top up.`,
      });
    }

    const ride = await Ride.findOneAndUpdate(
      {
        _id: req.params.id,
        status: 'requested',
        driver: null,
        rider: { $ne: req.user._id },
      },
      { status: 'accepted', driver: req.user._id, acceptedAt: new Date() },
      { new: true }
    ).populate('rider', PERSON_FIELDS);

    if (!ride) {
      return res
        .status(409)
        .json({ success: false, message: 'This ride is no longer available.' });
    }

    return res.json({ success: true, ride });
  } catch (err) {
    return serverError(res, err, 'acceptRide');
  }
};

// PATCH /api/rides/:id/decline
exports.declineRide = async (req, res) => {
  try {
    await Ride.updateOne(
      { _id: req.params.id, status: 'requested' },
      { $addToSet: { declinedBy: req.user._id } }
    );
    return res.json({ success: true });
  } catch (err) {
    return serverError(res, err, 'declineRide');
  }
};

// PATCH /api/rides/:id/start - passenger picked up
exports.startRide = async (req, res) => {
  try {
    const ride = await Ride.findOneAndUpdate(
      { _id: req.params.id, driver: req.user._id, status: 'accepted' },
      { status: 'in_progress', startedAt: new Date() },
      { new: true }
    ).populate('rider', PERSON_FIELDS);

    if (!ride) {
      return res
        .status(409)
        .json({ success: false, message: 'This ride cannot be started.' });
    }
    return res.json({ success: true, ride });
  } catch (err) {
    return serverError(res, err, 'startRide');
  }
};

// PATCH /api/rides/:id/complete - passenger dropped off
// Takes the 30% company share out of the driver's prepaid balance.
exports.completeRide = async (req, res) => {
  try {
    const filter = {
      _id: req.params.id,
      driver: req.user._id,
      status: { $in: ACTIVE_STATUSES },
    };

    const existing = await Ride.findOne(filter).select('fare');
    if (!existing) {
      return res
        .status(409)
        .json({ success: false, message: 'This ride cannot be completed.' });
    }

    const commission = commissionFor(existing.fare);

    // The status filter makes sure this can only succeed once per ride
    const ride = await Ride.findOneAndUpdate(
      filter,
      {
        status: 'completed',
        completedAt: new Date(),
        commission,
        driverEarning: Number(existing.fare) - commission,
      },
      { new: true }
    ).populate('rider', PERSON_FIELDS);

    if (!ride) {
      return res
        .status(409)
        .json({ success: false, message: 'This ride cannot be completed.' });
    }

    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user._id },
      { $inc: { balance: -commission } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    await WalletTx.create({
      user: req.user._id,
      type: 'commission',
      amount: commission,
      balanceAfter: wallet.balance,
      ride: ride._id,
      fare: ride.fare,
      pickup: ride.pickup?.address || '',
      dropoff: ride.destination?.address || '',
      note: 'Company share (30%)',
    });

    return res.json({
      success: true,
      ride,
      commission,
      driverEarning: Number(ride.fare) - commission,
      balance: wallet.balance,
    });
  } catch (err) {
    return serverError(res, err, 'completeRide');
  }
};

// PATCH /api/rides/:id/location - driver sends live GPS position
exports.updateLocation = async (req, res) => {
  try {
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return res.status(400).json({ success: false, message: 'Invalid location.' });
    }

    const ride = await Ride.findOneAndUpdate(
      { _id: req.params.id, driver: req.user._id, status: { $in: ACTIVE_STATUSES } },
      { driverLocation: { lat, lng, updatedAt: new Date() } },
      { new: true }
    ).select('_id');

    if (!ride) {
      return res.status(409).json({ success: false, message: 'No active ride.' });
    }
    return res.json({ success: true });
  } catch (err) {
    return serverError(res, err, 'updateLocation');
  }
};

// PATCH /api/rides/:id/driver-cancel - driver gives the ride back (only before pickup)
exports.driverCancel = async (req, res) => {
  try {
    const reason = cleanReason(req.body && req.body.reason);
    const ride = await Ride.findOneAndUpdate(
      { _id: req.params.id, driver: req.user._id, status: 'accepted' },
      {
        status: 'requested',
        driver: null,
        acceptedAt: null,
        requestedAt: new Date(),
        driverLocation: { lat: null, lng: null, updatedAt: null },
        $addToSet: { declinedBy: req.user._id },
      },
      { new: true }
    );
    if (!ride) {
      return res.status(409).json({ success: false, message: 'You can only give a ride back before pickup.' });
    }
    await CancelLog.create({ user: req.user._id, role: 'driver', ride: ride._id, reason });
    const n = await CancelLog.countDocuments({
      user: req.user._id, role: 'driver', createdAt: { $gte: new Date(Date.now() - DAY_MS) },
    });
    const io = req.app.get('io');
    if (io) io.to('drivers').emit('new-ride-request', rideCard(ride));
    return res.json({
      success: true,
      warning: n >= 3 ? 'That was your 3rd give-back today. You cannot accept new rides for 1 hour.' : null,
    });
  } catch (err) {
    return serverError(res, err, 'driverCancel');
  }
};

// PATCH /api/rides/:id/end-early - rider or driver ends a trip that is already in progress
exports.endTripEarly = async (req, res) => {
  try {
    const uid = req.user._id;
    const existing = await Ride.findOne({
      _id: req.params.id, status: 'in_progress', $or: [{ rider: uid }, { driver: uid }],
    }).select('rider driver');
    if (!existing) {
      return res.status(409).json({ success: false, message: 'This trip cannot be ended.' });
    }
    const by = String(existing.rider) === String(uid) ? 'rider' : 'driver';
    const reason = cleanReason(req.body && req.body.reason);
    // No commission is charged when a trip ends early
    const ride = await Ride.findOneAndUpdate(
      { _id: existing._id, status: 'in_progress' },
      { status: 'cancelled', cancelledBy: by, cancellationReason: `During trip: ${reason}` },
      { new: true }
    );
    if (!ride) {
      return res.status(409).json({ success: false, message: 'This trip cannot be ended.' });
    }
    console.log(`[rides] trip ${ride._id} ended early by ${by}: ${reason}`);
    return res.json({ success: true });
  } catch (err) {
    return serverError(res, err, 'endTripEarly');
  }
};

// GET /api/rides/admin/early-ended - for the admin page
exports.adminEarlyEnded = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access only.' });
    }
    const rides = await Ride.find({
      status: 'cancelled',
      $or: [{ cancellationReason: /^During trip:/ }, { cancellationReason: /Safety concern/ }],
    }).sort({ updatedAt: -1 }).limit(20).populate('rider', 'name').populate('driver', 'name').lean();
    return res.json({
      success: true,
      rides: rides.map((r) => ({
        id: r._id, rider: r.rider && r.rider.name, driver: r.driver && r.driver.name,
        by: r.cancelledBy, reason: r.cancellationReason, at: r.updatedAt, pickup: r.pickup && r.pickup.address,
      })),
    });
  } catch (err) {
    return serverError(res, err, 'adminEarlyEnded');
  }
};