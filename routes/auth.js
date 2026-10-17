// ============================================================
//  DANRIDES — routes/auth.js
// ============================================================
const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User     = require('../models/User');
const Driver   = require('../models/Driver');
const authMiddleware = require('../middleware/auth');

// ── Helper: sign JWT ─────────────────────────────────────────
const signToken = (id, role) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('phone').notEmpty().withMessage('Phone required'),
  body('password').isLength({ min: 6 }).withMessage('Min 6 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { name, email, phone, password, role } = req.body;
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ success: false, message: 'Email already registered' });

    const user = await User.create({ name, email, phone, password, role: role || 'rider' });
    const token = signToken(user._id, user.role);

    res.status(201).json({ success: true, token, user: { id: user._id, name, email, role: user.role } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', [
  body('email').isEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (!user.isActive)
      return res.status(403).json({ success: false, message: 'Account suspended' });

    user.lastSeen = new Date();
    await user.save({ validateBeforeSave: false });

    const token = signToken(user._id, user.role);
    res.json({ success: true, token, user: { id: user._id, name: user.name, email, role: user.role } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', authMiddleware, async (req, res) => {
  const token = signToken(req.user.id, req.user.role);
  res.json({ success: true, token });
});

// ── POST /api/auth/forgot-password ───────────────────────────
router.post('/forgot-password', [body('email').isEmail()], async (req, res) => {
  try {
    const user = await User.findOne({ email: req.body.email });
    if (!user) return res.json({ success: true, message: 'If account exists, OTP sent.' });
    // In production: generate OTP, store hash, send via SMS/email
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`OTP for ${user.email}: ${otp}`);  // replace with SMS
    res.json({ success: true, message: 'OTP sent to your registered contact' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
