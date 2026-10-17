// ============================================================
//  DANRIDES — routes/payments.js  (Stripe)
// ============================================================
const express = require('express');
const router  = express.Router();
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const auth    = require('../middleware/auth');
const Ride    = require('../models/Ride');
const User    = require('../models/User');

// ── POST /api/payments/intent ─────────────────────────────────
// Create a Stripe PaymentIntent for a ride
router.post('/intent', auth, async (req, res) => {
  try {
    const { rideId } = req.body;
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });

    const intent = await stripe.paymentIntents.create({
      amount:   ride.estimatedFare * 100,   // Stripe uses smallest currency unit
      currency: 'pkr',
      metadata: { rideId: ride._id.toString(), riderId: req.user.id },
    });

    res.json({ success: true, clientSecret: intent.client_secret });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/payments/webhook ────────────────────────────────
// Stripe webhook — confirm payment & mark ride paid
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig   = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const { rideId } = event.data.object.metadata;
    await Ride.findByIdAndUpdate(rideId, {
      paymentStatus: 'paid',
      paymentId: event.data.object.id,
      finalFare:  event.data.object.amount / 100,
    });
  }

  res.json({ received: true });
});

// ── GET /api/payments/history ─────────────────────────────────
router.get('/history', auth, async (req, res) => {
  try {
    const rides = await Ride.find({
      rider: req.user.id, paymentStatus: 'paid'
    }).sort({ completedAt: -1 }).limit(20).select('estimatedFare finalFare paymentMethod completedAt status');
    res.json({ success: true, payments: rides });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
