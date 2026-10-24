// Ride chat, vehicle details, forgot password, account deletion, in-ride reports
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const protect = require('../middleware/auth');
const User = require('../models/User');
const Ride = require('../models/Ride');
const Profile = require('../models/Profile');
const SOSAlert = require('../models/SOSAlert');
const { Wallet } = require('../models/Wallet');
const { CommunityMessage, CommunityMember, CommunityReport } = require('../models/CommunityModel');
const { RideMessage, Vehicle, PasswordReset } = require('../models/ExtraModels');

let bcrypt;
try { bcrypt = require('bcryptjs'); } catch (e) { bcrypt = require('bcrypt'); }
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* email stays off until it is installed */ }

const router = express.Router();
const isProd = process.env.NODE_ENV === 'production';
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const emailRegex = (email) =>
  new RegExp('^' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
const REPORTS_TO_SUSPEND = 3;

// ---------------------------------------------------------------------------
// Rider: is there a ride in progress? (powers the "Active ride" banner)
// ---------------------------------------------------------------------------
router.get('/active-ride', protect, wrap(async (req, res) => {
  const ride = await Ride.findOne({
    rider: req.user._id,
    status: { $in: ['requested', 'accepted', 'in_progress'] },
  }).sort({ createdAt: -1 }).select('_id status').lean();
  res.json({ success: true, ride });
}));

// ---------------------------------------------------------------------------
// Driver's vehicle
// ---------------------------------------------------------------------------
router.post('/vehicle', protect, wrap(async (req, res) => {
  if (req.user.role !== 'driver') return bad(res, 'Driver access only.', 403);
  const v = {
    vehicleType: String(req.body.vehicleType || ''),
    model: String(req.body.model || '').trim().slice(0, 40),
    color: String(req.body.color || '').trim().slice(0, 30),
    plate: String(req.body.plate || '').trim().toUpperCase().slice(0, 15),
  };
  if (!['scooty', 'mini', 'ac'].includes(v.vehicleType) || !v.model || !v.color || v.plate.length < 3) {
    return bad(res, 'Fill in your vehicle type, model, color and number plate.');
  }
  await Vehicle.findOneAndUpdate({ user: req.user._id }, v, { upsert: true, setDefaultsOnInsert: true });
  res.json({ success: true });
}));

router.get('/ride/:rideId/vehicle', protect, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.rideId)) return bad(res, 'Bad ride.');
  const ride = await Ride.findOne({
    _id: req.params.rideId,
    $or: [{ rider: req.user._id }, { driver: req.user._id }],
  }).select('driver').lean();
  if (!ride || !ride.driver) return res.json({ success: true, vehicle: null });
  const v = await Vehicle.findOne({ user: ride.driver }).lean();
  res.json({
    success: true,
    vehicle: v ? { type: v.vehicleType, model: v.model, color: v.color, plate: v.plate } : null,
  });
}));

// ---------------------------------------------------------------------------
// In-app ride chat (only the rider and driver of an active ride)
// ---------------------------------------------------------------------------
router.get('/vehicle/me', protect, wrap(async (req, res) => {
  const v = await Vehicle.findOne({ user: req.user._id }).lean();
  res.json({
    success: true,
    vehicle: v ? { type: v.vehicleType, model: v.model, color: v.color, plate: v.plate } : null,
  });
}));

// The other person's phone number, released only while the ride is active
router.get('/ride/:rideId/contact', protect, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.rideId)) return bad(res, 'Bad ride.');
  const ride = await Ride.findOne({
    _id: req.params.rideId,
    status: { $in: ['accepted', 'in_progress'] },
    $or: [{ rider: req.user._id }, { driver: req.user._id }],
  }).select('rider driver').lean();
  if (!ride || !ride.driver) return bad(res, 'Calls are only available during a ride.', 403);
  const otherId = String(ride.rider) === String(req.user._id) ? ride.driver : ride.rider;
  const other = await User.findById(otherId).select('phone').lean();
  if (!other || !other.phone) return bad(res, 'No phone number available.', 404);
  res.json({ success: true, phone: other.phone });
}));

const chatLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => String(req.user.id),
  message: { success: false, message: 'Slow down a little.' },
});

const participant = wrap(async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.rideId)) return bad(res, 'Bad ride.');
  const ride = await Ride.findOne({
    _id: req.params.rideId,
    $or: [{ rider: req.user._id }, { driver: req.user._id }],
    status: { $in: ['accepted', 'in_progress'] },
  }).select('_id').lean();
  if (!ride) return bad(res, 'Chat is only open during a ride.', 403);
  return next();
});

router.get('/ridechat/:rideId', protect, participant, wrap(async (req, res) => {
  const list = await RideMessage.find({ ride: req.params.rideId })
    .sort({ createdAt: 1 }).limit(100).populate('author', 'name').lean();
  res.json({
    success: true,
    messages: list.filter((m) => m.author).map((m) => ({
      _id: m._id, text: m.text, createdAt: m.createdAt,
      mine: String(m.author._id) === String(req.user._id), name: m.author.name,
    })),
  });
}));

router.post('/ridechat/:rideId', protect, participant, chatLimit, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 400);
  if (!text) return bad(res, 'Write a message first.');
  await RideMessage.create({ ride: req.params.rideId, author: req.user._id, text });
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Report the other person of a ride you shared (3 different reports pause the account)
// ---------------------------------------------------------------------------
router.post('/report-user', protect, wrap(async (req, res) => {
  const { userId, rideId } = req.body;
  if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(rideId)) return bad(res, 'Bad request.');
  if (String(userId) === String(req.user._id)) return bad(res, 'You cannot report yourself.');

  const shared = await Ride.exists({
    _id: rideId,
    $or: [
      { rider: req.user._id, driver: userId },
      { driver: req.user._id, rider: userId },
    ],
  });
  if (!shared) return bad(res, 'You can only report someone from your own ride.', 403);

  try {
    await CommunityReport.create({
      reporter: req.user._id, reported: userId,
      reason: String(req.body.reason || 'Reported during a ride').slice(0, 200),
    });
  } catch (err) {
    if (err.code !== 11000) throw err; // already reported by this person
  }

  const count = await CommunityReport.countDocuments({ reported: userId });
  if (count >= REPORTS_TO_SUSPEND) {
    await User.updateOne({ _id: userId, role: { $ne: 'admin' } }, { isActive: false });
  }
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Forgot password (6-digit code by email)
// ---------------------------------------------------------------------------
const forgotLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { success: false, message: 'Too many tries. Please wait 15 minutes.' },
});
const resetLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { success: false, message: 'Too many tries. Please wait 15 minutes.' },
});

const hashCode = (code) =>
  crypto.createHash('sha256').update(code + (process.env.JWT_SECRET || '')).digest('hex');

async function sendMail(to, subject, text) {
  if (nodemailer && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const port = Number(process.env.SMTP_PORT) || 465;
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({ from: `"Blushway" <${process.env.SMTP_USER}>`, to, subject, text });
    return;
  }
  // Email is not set up yet. In testing we print the code in the terminal.
  console.log('[mail not configured]', isProd ? subject : `${to} | ${subject} | ${text}`);
}

router.post('/password/forgot', forgotLimit, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const generic = { success: true, message: 'If that email has an account, we sent a 6-digit code to it.' };
  if (!email) return res.json(generic);

  const user = await User.findOne({ email: emailRegex(email) });
  if (user && user.isActive !== false) {
    const code = String(crypto.randomInt(100000, 1000000));
    await PasswordReset.findOneAndUpdate(
      { user: user._id },
      { codeHash: hashCode(code), attempts: 0, expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
      { upsert: true, setDefaultsOnInsert: true }
    );
    try {
      await sendMail(user.email, 'Your Blushway password code',
        `Your Blushway code is ${code}. It works for 15 minutes. If you did not ask for it, you can ignore this email.`);
    } catch (err) {
      console.error('[mail] could not send:', err.message);
    }
  }
  res.json(generic);
}));

router.post('/password/reset', resetLimit, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const pw = String(req.body.newPassword || '');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return bad(res, 'Password needs 8+ characters, a letter and a number.');
  }
  const wrong = 'This code is wrong or has expired.';
  const user = email ? await User.findOne({ email: emailRegex(email) }) : null;
  const rec = user ? await PasswordReset.findOne({ user: user._id }) : null;
  if (!rec || rec.expiresAt < new Date()) return bad(res, wrong);
  if (rec.attempts >= 5) {
    await PasswordReset.deleteOne({ _id: rec._id });
    return bad(res, 'Too many wrong tries. Please ask for a new code.');
  }
  if (rec.codeHash !== hashCode(code)) {
    rec.attempts += 1;
    await rec.save();
    return bad(res, wrong);
  }
  const hash = await bcrypt.hash(pw, 12);
  await User.updateOne({ _id: user._id }, { password: hash });
  await PasswordReset.deleteOne({ _id: rec._id });
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Delete my account (required by Google Play)
// ---------------------------------------------------------------------------
router.post('/account/delete', protect, wrap(async (req, res) => {
  if (req.user.role === 'admin') return bad(res, 'Admin accounts cannot be deleted here.', 403);
  if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') return bad(res, 'Type DELETE to confirm.');

  const uid = req.user._id;
  const busy = await Ride.exists({
    $or: [{ rider: uid }, { driver: uid }],
    status: { $in: ['requested', 'accepted', 'in_progress'] },
  });
  if (busy) return bad(res, 'Finish or cancel your current ride first.', 409);

  const wallet = await Wallet.findOne({ user: uid }).lean();
  if (wallet && wallet.balance > 0) {
    return bad(res, `You still have Rs ${wallet.balance} in your wallet. Contact Blushway support to get it back, then delete your account.`, 409);
  }

  const profile = await Profile.findOne({ user: uid }).lean();
  [profile && profile.selfieFile, profile && profile.cnicFile].forEach((f) => {
    if (f) fs.unlink(path.join(__dirname, '..', 'private_uploads', path.basename(f)), () => {});
  });

  await Promise.all([
    Profile.deleteOne({ user: uid }),
    Vehicle.deleteMany({ user: uid }),
    PasswordReset.deleteMany({ user: uid }),
    RideMessage.deleteMany({ author: uid }),
    CommunityMember.deleteMany({ user: uid }),
    CommunityMessage.deleteMany({ author: uid }),
    CommunityReport.deleteMany({ $or: [{ reporter: uid }, { reported: uid }] }),
    SOSAlert.deleteMany({ user: uid }),
  ]);

  // Keep the ride records for accounting, but remove who she was
  await User.updateOne({ _id: uid }, {
    name: 'Deleted user', email: `deleted-${uid}@deleted.blushway`, phone: `deleted-${uid}`, isActive: false,
  });
  res.json({ success: true });
}));

module.exports = router;