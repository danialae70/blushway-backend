const Ride = require('../models/Ride');
const { rideCard } = require('../utils/rideCard');

const ACCEPT_TIMEOUT_MS = 3 * 60 * 1000;  // driver silent for 3 minutes -> ride goes back to the pool
const REQUEST_TTL_MS = 10 * 60 * 1000;    // nobody accepted for 10 minutes -> cancelled

module.exports = (io) => {
  const run = async () => {
    try {
      const staleBefore = new Date(Date.now() - ACCEPT_TIMEOUT_MS);
      const stuck = await Ride.find({
        status: 'accepted',
        $or: [
          { 'driverLocation.updatedAt': { $lt: staleBefore } },
          { 'driverLocation.updatedAt': null, acceptedAt: { $lt: staleBefore } },
        ],
      });

      for (const r of stuck) {
        const released = await Ride.findOneAndUpdate(
          { _id: r._id, status: 'accepted' },
          {
            status: 'requested',
            driver: null,
            acceptedAt: null,
            requestedAt: new Date(),
            driverLocation: { lat: null, lng: null, updatedAt: null },
            $addToSet: { declinedBy: r.driver },
          },
          { new: true }
        );
        if (released && io) io.to('drivers').emit('new-ride-request', rideCard(released));
        if (released) console.log('[jobs] released stuck ride', String(r._id));
      }

      await Ride.updateMany(
        { status: 'requested', requestedAt: { $lt: new Date(Date.now() - REQUEST_TTL_MS) } },
        { status: 'cancelled', cancelledBy: 'system', cancellationReason: 'No captain accepted in time' }
      );
    } catch (err) {
      console.error('[jobs] error:', err.message);
    }
  };

  setInterval(run, 30 * 1000);
};
