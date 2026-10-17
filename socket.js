// ============================================================
//  DANRIDES — socket.js  (Real-time ride tracking)
// ============================================================
const jwt  = require('jsonwebtoken');
const Ride = require('./models/Ride');

// Maps: rideId → { riderSocketId, driverSocketId }
const activeRides = new Map();

module.exports = function socketHandler(io) {

  // ── Auth middleware ──────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch { next(new Error('Invalid token')); }
  });
io.on('connection', (socket) => {
  console.log(`🔌  Socket connected: ${socket.user.id} (${socket.user.role})`);

  // ── ADMIN SAFETY ROOM ─────────────────────────────────────
  if (socket.user.role === 'admin') {
    socket.join('admin:room');
    console.log(`🛡️ Admin ${socket.user.id} joined safety room`);
  }

  // ── RIDER EVENTS ─────────────────────────────────────────
 
    // ── RIDER EVENTS ─────────────────────────────────────────
    socket.on('rider:requestRide', async (data) => {
      const { rideId } = data;
      socket.join(`ride:${rideId}`);
      activeRides.set(rideId, { ...(activeRides.get(rideId) || {}), riderSocket: socket.id });
      io.to(`drivers:online`).emit('driver:newRideRequest', { rideId, ...data });
    });

    socket.on('rider:joinRoom', ({ rideId }) => {
      socket.join(`ride:${rideId}`);
    });

    // ── DRIVER EVENTS ─────────────────────────────────────────
    socket.on('driver:goOnline', () => {
      socket.join('drivers:online');
      console.log(`🚗  Driver ${socket.user.id} went online`);
    });

    socket.on('driver:goOffline', () => {
      socket.leave('drivers:online');
    });

    socket.on('driver:acceptRide', async ({ rideId }) => {
      socket.join(`ride:${rideId}`);
      activeRides.set(rideId, { ...(activeRides.get(rideId) || {}), driverSocket: socket.id });
      io.to(`ride:${rideId}`).emit('ride:driverAssigned', {
        driverId: socket.user.id,
        message: 'Your driver is on the way! 🌸'
      });
    });

    // ── LIVE LOCATION UPDATE ──────────────────────────────────
    socket.on('driver:locationUpdate', ({ rideId, lat, lng, heading }) => {
      io.to(`ride:${rideId}`).emit('ride:driverLocation', { lat, lng, heading, timestamp: Date.now() });
    });

    // ── RIDE STATUS EVENTS ────────────────────────────────────
    socket.on('driver:arrivedAtPickup', ({ rideId }) => {
      io.to(`ride:${rideId}`).emit('ride:driverArrived', { message: 'Your driver has arrived! 🌸' });
    });

    socket.on('driver:startRide', async ({ rideId }) => {
      await Ride.findByIdAndUpdate(rideId, { status: 'in_progress', startedAt: new Date() });
      io.to(`ride:${rideId}`).emit('ride:started', { message: 'Ride has started! Stay safe 🌸' });
    });

    socket.on('driver:endRide', async ({ rideId, fare }) => {
      await Ride.findByIdAndUpdate(rideId, { status: 'completed', fare, completedAt: new Date() });
      io.to(`ride:${rideId}`).emit('ride:completed', { fare, message: 'You have arrived! Thank you for riding with Danrides 🌸' });
      activeRides.delete(rideId);
    });

    // ── SOS EMERGENCY ─────────────────────────────────────────
    // ── SOS EMERGENCY ─────────────────────────────────────────────
socket.on('rider:sos', async ({ rideId, lat, lng }) => {
  try {
    console.log(`🚨 SOS triggered by ${socket.user.id} for ride ${rideId}`);

    const user = await require('./models/User')
      .findById(socket.user.id)
      .select('name phone emergencyContacts');

    if (!user) {
      return socket.emit('sos:error', {
        message: 'Unable to identify your account.'
      });
    }

    const sosData = {
      rideId: rideId || null,
      userId: socket.user.id,
      riderName: user.name,
      riderPhone: user.phone,
      lat,
      lng,
      time: new Date()
    };

    // 1. Alert Danrides safety/admin team
    io.to('admin:room').emit('sos:alert', sosData);

    // 2. Alert everyone currently connected to this ride
    if (rideId) {
      io.to(`ride:${rideId}`).emit('sos:alert', sosData);
    }

    // 3. Tell the rider that SOS was successfully received
    socket.emit('sos:confirmed', {
      message: 'SOS sent! Your emergency contacts and Danrides safety team have been alerted.',
      location: {
        lat,
        lng
      },
      emergencyContacts: user.emergencyContacts || []
    });

    // 4. Put the rider into a dedicated SOS room.
    // Emergency-contact clients can join this room using the SOS ID.
    const sosRoom = `sos:${socket.user.id}`;

    socket.join(sosRoom);

    // 5. Send initial location to the SOS room
    io.to(sosRoom).emit('sos:location', {
      lat,
      lng,
      timestamp: Date.now()
    });

    console.log(
      `🚨 SOS processed for ${user.name}. Contacts: ${user.emergencyContacts?.length || 0}`
    );

  } catch (err) {
    console.error('SOS error:', err);

    socket.emit('sos:error', {
      message: 'SOS could not be processed. Please call emergency services directly.'
    });
  }
});


// ── SOS LIVE LOCATION ─────────────────────────────────────────
socket.on('rider:sosLocation', ({ lat, lng }) => {
  const sosRoom = `sos:${socket.user.id}`;

  io.to(sosRoom).emit('sos:location', {
    lat,
    lng,
    timestamp: Date.now()
  });
});


// ── JOIN SOS LOCATION ROOM ───────────────────────────────────
socket.on('emergency:joinSOS', ({ userId }) => {
  if (!userId) return;

  socket.join(`sos:${userId}`);

  console.log(
    `🚨 Emergency contact joined SOS room for user ${userId}`
  );
});


// ── END SOS ──────────────────────────────────────────────────
socket.on('rider:endSOS', () => {
  const sosRoom = `sos:${socket.user.id}`;

  io.to(sosRoom).emit('sos:ended', {
    message: 'The SOS alert has ended.',
    timestamp: Date.now()
  });

  socket.emit('sos:ended', {
    message: 'SOS alert ended.'
  });

  console.log(`✅ SOS ended by ${socket.user.id}`);
});
    // ── CHAT ──────────────────────────────────────────────────
    socket.on('chat:send', ({ rideId, message }) => {
      io.to(`ride:${rideId}`).emit('chat:receive', {
        from: socket.user.id, message, time: new Date()
      });
    });

    // ── DISCONNECT ────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`🔌  Socket disconnected: ${socket.user.id}`);
    });
  });
};
