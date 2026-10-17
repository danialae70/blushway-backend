const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const protect = require('../middleware/auth');
const User = require('../models/User');
const Profile = require('../models/Profile');
const SOSAlert = require('../models/SOSAlert');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const num = (v, lim) => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= lim ? n : null; };
const isAdmin = (req) => req.user && req.user.role === 'admin';

// Saved emergency contacts (max 3)
router.get('/contacts', protect, wrap(async (req, res) => {
  const p = await Profile.findOne({ user: req.user._id }).lean();
  res.json({ success: true, contacts: (p && p.emergencyContacts) || [] });
}));

router.put('/contacts', protect, wrap(async (req, res) => {
  const list = (Array.isArray(req.body.contacts) ? req.body.contacts : []).slice(0, 3)
    .map((c) => ({ name: String((c && c.name) || '').trim().slice(0, 40), phone: String((c && c.phone) || '').replace(/[^0-9+]/g, '').slice(0, 16) }))
    .filter((c) => c.name && c.phone.length >= 7);
  const p = await Profile.findOneAndUpdate({ user: req.user._id }, { emergencyContacts: list }, { new: true, upsert: true, setDefaultsOnInsert: true });
  res.json({ success: true, contacts: p.emergencyContacts });
}));

// Start an SOS: creates a secret live-location link and alerts the admin
router.post('/start', protect, wrap(async (req, res) => {
  const lat = num(req.body.lat, 90), lng = num(req.body.lng, 180);
  if (lat === null || lng === null) return res.status(400).json({ success: false, message: 'Location is missing.' });

  let a = await SOSAlert.findOne({ user: req.user._id, status: 'active' });
  if (!a) {
    a = await SOSAlert.create({
      user: req.user._id, lat, lng, token: crypto.randomBytes(16).toString('hex'),
      ride: mongoose.isValidObjectId(req.body.rideId) ? req.body.rideId : null,
    });
  } else { a.lat = lat; a.lng = lng; await a.save(); }

  const [u, p] = await Promise.all([User.findById(req.user._id).select('name phone').lean(), Profile.findOne({ user: req.user._id }).lean()]);
  const io = req.app.get('io');
  if (io) io.to('admins').emit('sos-alert', { token: a.token, name: u && u.name, phone: u && u.phone, lat, lng });
  console.log('🚨 SOS started by', u && u.name);
  res.json({ success: true, token: a.token, contacts: (p && p.emergencyContacts) || [] });
}));

// Keep the live location fresh
router.patch('/:token/location', protect, wrap(async (req, res) => {
  const lat = num(req.body.lat, 90), lng = num(req.body.lng, 180);
  if (lat === null || lng === null) return res.status(400).json({ success: false });
  const a = await SOSAlert.findOneAndUpdate({ token: String(req.params.token), user: req.user._id, status: 'active' }, { lat, lng }, { new: true });
  res.json({ success: !!a });
}));

router.post('/:token/resolve', protect, wrap(async (req, res) => {
  const filter = { token: String(req.params.token), status: 'active' };
  if (!isAdmin(req)) filter.user = req.user._id;
  await SOSAlert.updateOne(filter, { status: 'resolved' });
  res.json({ success: true });
}));

// Public link for emergency contacts (no login, secret 32-character token)
router.get('/public/:token', wrap(async (req, res) => {
  const a = await SOSAlert.findOne({ token: String(req.params.token) }).populate('user', 'name').lean();
  if (!a) return res.status(404).json({ success: false, message: 'Link not found.' });
  res.json({ success: true, name: (a.user && a.user.name) || 'A Danrides rider', lat: a.lat, lng: a.lng, status: a.status, updatedAt: a.updatedAt });
}));

// Admin: active alerts
router.get('/admin/active', protect, wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Admin access only.' });
  const list = await SOSAlert.find({ status: 'active' }).sort({ updatedAt: -1 }).limit(20).populate('user', 'name phone').lean();
  res.json({ success: true, alerts: list.map((a) => ({ token: a.token, name: a.user && a.user.name, phone: a.user && a.user.phone, lat: a.lat, lng: a.lng, updatedAt: a.updatedAt })) });
}));

module.exports = router;
