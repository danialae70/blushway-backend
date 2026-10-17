// Blushway Community: one group for every account holder + women-only reporting
const express = require('express');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const protect = require('../middleware/auth');
const User = require('../models/User');
const { CommunityMessage, CommunityMember, CommunityReport } = require('../models/CommunityModel');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const isAdmin = (req) => req.user && req.user.role === 'admin';

const REPORTS_TO_SUSPEND = 3; // 3 different members report someone -> account is suspended until the admin checks

const postLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => String(req.user.id),
  message: { success: false, message: 'Slow down a little.' },
});

// Drivers cannot use the community, only passengers
const passengerOnly = (req, res, next) =>
  req.user && req.user.role === 'driver'
    ? res.status(403).json({ success: false, message: 'Blushway Community is for passengers only.' })
    : next();

const member = wrap(async (req, res, next) => {
  if (await CommunityMember.exists({ user: req.user._id })) return next();
  return res.status(403).json({ success: false, message: 'Join Blushway Community first.' });
});

router.get('/me', protect, passengerOnly, wrap(async (req, res) => {
  const [joined, members] = await Promise.all([
    CommunityMember.exists({ user: req.user._id }),
    CommunityMember.countDocuments(),
  ]);
  res.json({ success: true, joined: !!joined, members });
}));

router.post('/join', protect, passengerOnly, wrap(async (req, res) => {
  await CommunityMember.updateOne({ user: req.user._id }, { user: req.user._id }, { upsert: true });
  res.json({ success: true });
}));

router.get('/messages', protect, passengerOnly, member, wrap(async (req, res) => {
  const list = await CommunityMessage.find().sort({ createdAt: -1 }).limit(100).populate('author', 'name role isActive').lean();
  const messages = list
    .filter((m) => m.author && m.author.isActive !== false && m.author.role !== 'driver') // suspended members disappear
    .reverse()
    .map((m) => ({
      _id: m._id, text: m.text, createdAt: m.createdAt,
      author: { id: m.author._id, name: m.author.name, role: m.author.role },
    }));
  res.json({ success: true, messages });
}));

router.post('/messages', protect, passengerOnly, member, postLimit, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ success: false, message: 'Write a message first.' });
  await CommunityMessage.create({ author: req.user._id, text });
  res.json({ success: true });
}));

// Any member can report someone who should not be here
router.post('/report', protect, passengerOnly, member, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.body.messageId)) return res.status(400).json({ success: false, message: 'Bad message.' });
  const msg = await CommunityMessage.findById(req.body.messageId).lean();
  if (!msg) return res.status(404).json({ success: false, message: 'Message not found.' });
  if (String(msg.author) === String(req.user._id)) return res.status(400).json({ success: false, message: 'You cannot report yourself.' });

  try {
    await CommunityReport.create({
      reporter: req.user._id, reported: msg.author, message: msg._id,
      reason: String(req.body.reason || '').slice(0, 200),
    });
  } catch (err) {
    if (err.code !== 11000) throw err; // already reported by this member
  }

  const count = await CommunityReport.countDocuments({ reported: msg.author });
  let suspended = false;
  if (count >= REPORTS_TO_SUSPEND) {
    await User.updateOne({ _id: msg.author, role: { $ne: 'admin' } }, { isActive: false });
    suspended = true;
  }
  res.json({ success: true, suspended });
}));

// ---- admin ----
router.get('/admin/reports', protect, wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Admin access only.' });
  const rows = await CommunityReport.aggregate([
    { $group: { _id: '$reported', count: { $sum: 1 }, last: { $max: '$createdAt' } } },
    { $sort: { last: -1 } },
    { $limit: 50 },
  ]);
  const users = await User.find({ _id: { $in: rows.map((r) => r._id) } }).select('name email phone role isActive').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  res.json({
    success: true,
    reports: rows.filter((r) => byId.has(String(r._id))).map((r) => ({
      userId: r._id, count: r.count, last: r.last,
      name: byId.get(String(r._id)).name, email: byId.get(String(r._id)).email,
      phone: byId.get(String(r._id)).phone, active: byId.get(String(r._id)).isActive !== false,
    })),
  });
}));

router.post('/admin/user-status', protect, wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Admin access only.' });
  if (!mongoose.isValidObjectId(req.body.userId)) return res.status(400).json({ success: false, message: 'Bad user.' });
  const active = req.body.active === true;
  await User.updateOne({ _id: req.body.userId, role: { $ne: 'admin' } }, { isActive: active });
  if (active) await CommunityReport.deleteMany({ reported: req.body.userId }); // fresh start after restoring
  res.json({ success: true });
}));

module.exports = router;
