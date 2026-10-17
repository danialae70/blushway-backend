const express = require('express');
const { body, param, validationResult } = require('express-validator');

// Sets req.user (with _id and role) from the login token
const protect = require('../middleware/auth');
const ctrl = require('../controllers/rideController.js');

const router = express.Router();

// ---- helpers ---------------------------------------------------------------

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  return res.status(400).json({
    success: false,
    message: errors.array()[0].msg,
    errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
  });
};

const requireDriver = (req, res, next) =>
  req.user && req.user.role === 'driver'
    ? next()
    : res.status(403).json({ success: false, message: 'Driver access only.' });

const idRule = [param('id').isMongoId().withMessage('Invalid ride id'), validate];

const pointRules = (field, label) => [
  body(`${field}.address`).isString().trim().notEmpty().withMessage(`${label} address is required`),
  body(`${field}.coordinates`).isArray({ min: 2, max: 2 }).withMessage(`${label} coordinates must be [longitude, latitude]`),
  body(`${field}.coordinates[0]`).isFloat({ min: -180, max: 180 }).withMessage(`${label} longitude is invalid`),
  body(`${field}.coordinates[1]`).isFloat({ min: -90, max: 90 }).withMessage(`${label} latitude is invalid`),
];

// The fare is worked out by the server, so the phone does not have to send it
const bookRules = [
  ...pointRules('pickup', 'Pickup'),
  ...pointRules('destination', 'Destination'),
  body('rideType').optional().isIn(['scooty', 'mini', 'ac']).withMessage('Invalid ride type'),
  validate,
];

// ---- rider -----------------------------------------------------------------
router.post('/book', protect, bookRules, ctrl.bookRide);
router.get('/history', protect, ctrl.getHistory);

// ---- driver (declare BEFORE '/:id' so they are not captured by it) ----------
router.get('/requests', protect, requireDriver, ctrl.getRideRequests);
router.get('/driver/active', protect, requireDriver, ctrl.getActiveDriverRide);
router.patch('/:id/accept', protect, requireDriver, idRule, ctrl.acceptRide);
router.patch('/:id/decline', protect, requireDriver, idRule, ctrl.declineRide);
router.patch('/:id/start', protect, requireDriver, idRule, ctrl.startRide);
router.patch('/:id/complete', protect, requireDriver, idRule, ctrl.completeRide);
router.patch('/:id/location', protect, requireDriver, idRule, ctrl.updateLocation);
router.patch('/:id/driver-cancel', protect, requireDriver, idRule, ctrl.driverCancel);

// ---- rider cancel ------------------------------------------------------------
router.patch('/:id/cancel', protect, idRule, ctrl.cancelRide);

// ---- shared ----------------------------------------------------------------
router.get('/:id', protect, idRule, ctrl.getRideById);

module.exports = router;
