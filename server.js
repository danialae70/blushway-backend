// ============================================================
//  DANRIDES — Women Always First
//  Backend Server — server.js (hardened)
// ============================================================
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const { Server } = require('socket.io');

const authRoutes    = require('./routes/auth');
const rideRoutes    = require('./routes/rideRoutes');
const walletRoutes  = require('./routes/walletRoutes');
const driverRoutes  = require('./routes/drivers');
const userRoutes    = require('./routes/users');
const paymentRoutes = require('./routes/payments');
const adminRoutes   = require('./routes/admin');
const socketHandler = require('./socket');
const kycRoutes     = require('./routes/kycRoutes');
const communityRoutes = require('./routes/communityRoutes');
const extraRoutes     = require('./routes/extraRoutes');
const sosRoutes     = require('./routes/sosRoutes');
const Profile       = require('./models/Profile');
const protect       = require('./middleware/auth');
const User          = require('./models/User');
const { sanitize, registerGuard } = require('./middleware/security');

const isProd = process.env.NODE_ENV === 'production';

// ── Secret check ─────────────────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  const msg = 'JWT_SECRET must be a long random value (32+ characters).';
  if (isProd) {
    console.error('❌  ' + msg);
    process.exit(1);
  } else {
    console.warn('⚠️  ' + msg + ' Fix this before launch.');
  }
}

// Allowed website addresses (comma separated in .env: CLIENT_URL=https://a.com,https://b.com)
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'] }
});
app.set('io', io);

// Needed so rate limits see the real visitor IP when hosted behind a proxy (Render, etc.)
if (isProd) app.set('trust proxy', 1);

// ── Security ─────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '50kb' }));
app.use(sanitize);
app.use(morgan(isProd ? 'combined' : 'dev'));

// ── Rate Limiting ─────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many requests.',
  skip: (req) => req.path.startsWith('/rides') || req.path.startsWith('/sos') || req.path.startsWith('/community') || req.path.startsWith('/extra')
});
app.use('/api/', limiter);

// Strict limit on login / sign up: only failed attempts are counted
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.post('/api/auth/register', registerGuard);

// ── Database ──────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/danrides', {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  family: 4
})
  .then(() => { console.log('✅  MongoDB connected'); require('./jobs/rideJobs')(io); })
  .catch(err => { console.error('❌  MongoDB error:', err); process.exit(1); });

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/rides',    rideRoutes);
app.use('/api/wallet',   walletRoutes);
app.use('/api/kyc',      kycRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/extra',     extraRoutes);
app.use('/api/sos',      sosRoutes);
app.use('/api/drivers',  driverRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin',    adminRoutes);

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', app: 'Blushway 🌸' }));

// ── EMERGENCY SOS (login required) ───────────────────────────
app.post('/api/emergency/sos', protect, async (req, res) => {
  try {
    const { latitude, longitude, service, message, userName, userPhone } = req.body;

    console.log('🚨 EMERGENCY SOS RECEIVED from user', String(req.user.id));

    // Only drivers and admins receive SOS alerts, not every connected user
    io.to('drivers').to('admins').emit('emergency_alert', {
      service: String(service || 'Emergency').slice(0, 60),
      userName: String(userName || 'Blushway User').slice(0, 80),
      userPhone: String(userPhone || '').slice(0, 20),
      latitude: Number.isFinite(Number(latitude)) ? Number(latitude) : null,
      longitude: Number.isFinite(Number(longitude)) ? Number(longitude) : null,
      message: String(message || 'Emergency SOS activated').slice(0, 300),
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: 'Emergency alert received' });
  } catch (error) {
    console.error('❌ SOS ERROR:', error);
    res.status(500).json({ success: false, message: 'Failed to send emergency alert' });
  }
});

// ── Error handler (no internal details in production) ────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: isProd ? 'Server error' : (err.message || 'Server error')
  });
});

// ── Socket.IO: only logged-in users can connect ──────────────
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('Unauthorized'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('role isActive');
    if (!user || !user.isActive) return next(new Error('Unauthorized'));

    socket.user = { id: String(user._id), role: user.role };
    if (user.role === 'driver') {
      const prof = await Profile.findOne({ user: user._id }).select('driverStatus').lean();
      if (prof && prof.driverStatus === 'approved') socket.join('drivers'); // approved drivers only
    }
    if (user.role === 'admin') socket.join('admins');
    return next();
  } catch (err) {
    return next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id, socket.user && socket.user.role);
});
socketHandler(io);

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🌸  Blushway backend running on port ${PORT}`));

process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));

module.exports = { app, io };