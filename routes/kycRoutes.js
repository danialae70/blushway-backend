// Driver approval: documents are private, only an admin can see them
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const protect = require('../middleware/auth');
const Profile = require('../models/Profile');
const User = require('../models/User');

const router = express.Router();
const DIR = path.join(__dirname, '..', 'private_uploads'); // never served publicly
fs.mkdirSync(DIR, { recursive: true });

const IMG = ['.jpg', '.jpeg', '.png', '.webp'];
const upload = multer({
  storage: multer.diskStorage({
    destination: DIR,
    filename: (req, f, cb) =>
      cb(null, crypto.randomBytes(16).toString('hex') + path.extname(f.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 2 },
  fileFilter: (req, f, cb) => {
    const ok = IMG.includes(path.extname(f.originalname).toLowerCase()) && f.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Only image files (jpg, png, webp) are allowed.'), ok);
  },
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const only = (role, msg) => (req, res, next) =>
  req.user && req.user.role === role ? next() : res.status(403).json({ success: false, message: msg });
const requireDriver = only('driver', 'Driver access only.');
const requireAdmin = only('admin', 'Admin access only.');

// Driver: my approval status
router.get('/me', protect, requireDriver, wrap(async (req, res) => {
  const p = await Profile.findOne({ user: req.user._id }).lean();
  res.json({ success: true, status: (p && p.driverStatus) || 'none', note: (p && p.kycNote) || '' });
}));

// Driver: send CNIC number + selfie + CNIC photo
router.post('/', protect, requireDriver,
  upload.fields([{ name: 'selfie', maxCount: 1 }, { name: 'cnic', maxCount: 1 }]),
  wrap(async (req, res) => {
    const cnicNumber = String(req.body.cnicNumber || '').replace(/[^0-9]/g, '');
    const selfie = req.files && req.files.selfie && req.files.selfie[0];
    const cnic = req.files && req.files.cnic && req.files.cnic[0];

    if (cnicNumber.length !== 13) return res.status(400).json({ success: false, message: 'Enter your 13-digit CNIC number.' });
    if (!selfie || !cnic) return res.status(400).json({ success: false, message: 'Add both your selfie and a photo of your CNIC.' });

    const existing = await Profile.findOne({ user: req.user._id }).lean();
    if (existing && ['pending', 'approved'].includes(existing.driverStatus)) {
      return res.status(409).json({ success: false, message: 'Your documents are already ' + existing.driverStatus + '.' });
    }

    await Profile.findOneAndUpdate(
      { user: req.user._id },
      { driverStatus: 'pending', cnicNumber, selfieFile: selfie.filename, cnicFile: cnic.filename, kycNote: '', submittedAt: new Date() },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, status: 'pending' });
  })
);

// Admin: waiting list
router.get('/admin/pending', protect, requireAdmin, wrap(async (req, res) => {
  const list = await Profile.find({ driverStatus: 'pending' }).sort({ submittedAt: 1 }).populate('user', 'name email phone').lean();
  res.json({
    success: true,
    drivers: list.map((p) => ({
      userId: p.user && p.user._id, name: p.user && p.user.name, email: p.user && p.user.email,
      phone: p.user && p.user.phone, cnicNumber: p.cnicNumber, selfie: p.selfieFile, cnic: p.cnicFile, submittedAt: p.submittedAt,
    })),
  });
}));

// Admin: view one document
router.get('/file/:name', protect, requireAdmin, (req, res) => {
  res.sendFile(path.join(DIR, path.basename(req.params.name)), (err) => {
    if (err && !res.headersSent) res.status(404).json({ success: false, message: 'Not found.' });
  });
});

// Admin: approve or reject
router.post('/admin/decide', protect, requireAdmin, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.body.userId)) return res.status(400).json({ success: false, message: 'Bad user.' });
  const approve = req.body.approve === true;
  const p = await Profile.findOneAndUpdate(
    { user: req.body.userId },
    { driverStatus: approve ? 'approved' : 'rejected', kycNote: approve ? '' : String(req.body.note || 'Documents were not clear.').slice(0, 200) },
    { new: true }
  );
  if (!p) return res.status(404).json({ success: false, message: 'No documents found.' });
  res.json({ success: true, status: p.driverStatus });
}));

module.exports = router;
