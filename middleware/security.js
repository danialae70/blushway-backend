// ============================================================
//  DANRIDES — middleware/security.js
// ============================================================

const BLOCKED_KEYS = ['__proto__', 'constructor', 'prototype'];

// Removes keys that attackers use for NoSQL injection ($ne, $gt ...) and
// prototype pollution. Works in place, so it is safe on every Express version.
const clean = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 10) return;
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.') || BLOCKED_KEYS.includes(key)) {
      delete value[key];
      continue;
    }
    clean(value[key], depth + 1);
  }
};

exports.sanitize = (req, res, next) => {
  clean(req.body);
  clean(req.params);
  clean(req.query);
  next();
};

// Runs before /api/auth/register:
// - nobody can sign up as admin or set their own special fields
// - strong password rule
exports.registerGuard = (req, res, next) => {
  const body = req.body || {};

  body.role = body.role === 'driver' ? 'driver' : 'rider';

  ['isActive', 'isVerified', 'isAdmin', 'balance', 'rating', 'permissions'].forEach((k) => {
    delete body[k];
  });

  // Blushway is women-only: sign up needs the confirmation
  if (body.confirmFemale !== true) {
    return res.status(400).json({
      success: false,
      message: 'Blushway is for women only. Please confirm that you are a woman to join.',
    });
  }
  delete body.confirmFemale;

  const pw = String(body.password || '');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return res.status(400).json({
      success: false,
      message: 'Password must be at least 8 characters and include a letter and a number.',
    });
  }

  req.body = body;
  return next();
};