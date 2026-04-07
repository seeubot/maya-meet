require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const User = require('./models/User');

// Validate required environment variables
const requiredEnv = ['SESSION_SECRET', 'MONGODB_URI', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
for (const env of requiredEnv) {
  if (!process.env[env]) {
    console.error(`❌ Missing required environment variable: ${env}`);
    process.exit(1);
  }
}

// ── Logger ────────────────────────────────────────────────────────────────────
const LEVELS = { error: 0, warn: 1, info: 2, http: 3, debug: 4 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? 2;

function log(level, msg, meta = {}) {
  if ((LEVELS[level] ?? 99) > LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const label = level.toUpperCase().padEnd(5);
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${ts}] [${label}] ${msg}${extra}`);
}

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.APP_URL || '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.set('trust proxy', 1);

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:"],
      frameSrc: ["'none'"],
    }
  }
}));

app.use(cors({ origin: process.env.APP_URL || '*', credentials: true }));

const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });

app.use(globalLimiter);
app.use('/api/', apiLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const uid = req.user?._id?.toString() ?? 'guest';
    const code = res.statusCode;
    if (req.path !== '/socket.io/') {
      log('http', `${req.method.padEnd(6)} ${code} ${req.path}`, { ms, ip: req.ip, user: uid });
    }
  });
  next();
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => log('info', '✅ MongoDB connected'))
  .catch(err => log('error', '❌ MongoDB connection failed', { err: err.message }));

mongoose.connection.on('disconnected', () => log('warn', '⚠️ MongoDB disconnected'));
mongoose.connection.on('reconnected', () => log('info', '✅ MongoDB reconnected'));

mongoose.connection.once('open', async () => {
  try {
    await User.init();
    log('info', '✅ Database indexes ensured');
  } catch (err) {
    log('error', 'Index creation failed', { err: err.message });
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, ttl: 7 * 24 * 3600 }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  }
});
app.use(sessionMiddleware);

// ── Passport ──────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value;
    const avatar = profile.photos?.[0]?.value || '';
    const name = profile.displayName;

    // FIX: use $set for mutable fields (name, avatar) so they update on re-login.
    // Only googleId and email are treated as immutable via $setOnInsert.
    let user = await User.findOneAndUpdate(
      { googleId: profile.id },
      {
        $set: { name, avatar },
        $setOnInsert: {
          googleId: profile.id,
          email,
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    log('info', 'OAuth user processed', { id: user._id, email });
    return done(null, user);
  } catch (err) {
    log('error', 'OAuth strategy error', { err: err.message });
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user._id.toString()));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id).lean();
    done(null, user || false);
  } catch (err) {
    done(err, null);
  }
});

// ── Route guards ──────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/');
}

function requireOnboarded(req, res, next) {
  if (!req.isAuthenticated()) return res.redirect('/');
  if (!req.user.profileComplete) return res.redirect('/onboarding');
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

app.get('/', (req, res) => {
  if (!req.isAuthenticated()) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  if (!req.user.profileComplete) return res.redirect('/onboarding');
  return res.redirect('/app');
});

app.get('/onboarding', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'));
});

app.get('/app', requireOnboarded, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const wrap = mw => (socket, next) => mw(socket.request, {}, next);
io.use(wrap(sessionMiddleware));
io.use(wrap(passport.initialize()));
io.use(wrap(passport.session()));

io.use((socket, next) => {
  if (socket.request.user) return next();
  next(new Error('Unauthorized'));
});

const onlineUsers = new Map();

io.on('connection', async (socket) => {
  const userId = socket.request.user?._id?.toString();
  log('info', 'Socket connected', { id: socket.id, userId });

  // FIX: mark online on connection itself — don't wait for user:join.
  // Clients that never emit user:join would otherwise remain offline forever.
  if (userId) {
    onlineUsers.set(socket.id, userId);
    try {
      await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });
      io.emit('user:online', { userId });
      log('debug', 'User came online on connect', { userId });
    } catch (e) {
      log('warn', 'connection presence DB error', { err: e.message });
    }
  }

  // Keep user:join for backwards-compat / explicit re-join after tab resume
  socket.on('user:join', async () => {
    if (!userId) return;
    try {
      await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });
      io.emit('user:online', { userId });
      log('debug', 'User joined', { userId });
    } catch (e) {
      log('warn', 'user:join DB error', { err: e.message });
    }
  });

  socket.on('user:location', async ({ lat, lng }) => {
    if (!userId) return;
    const latN = parseFloat(lat), lngN = parseFloat(lng);
    if (isNaN(latN) || isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) return;
    try {
      await User.findByIdAndUpdate(userId, {
        location: { type: 'Point', coordinates: [lngN, latN] },
        lastSeen: new Date(),
        isOnline: true
      });
      socket.broadcast.emit('user:moved', { userId, lat: latN, lng: lngN });
    } catch (e) {
      log('warn', 'user:location error', { err: e.message });
    }
  });

  socket.on('disconnect', async () => {
    const uid = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (uid) {
      try {
        await User.findByIdAndUpdate(uid, { isOnline: false, lastSeen: new Date() });
        io.emit('user:offline', { userId: uid });
      } catch (e) { /* ignore */ }
    }
    log('info', 'Socket disconnected', { id: socket.id, userId: uid });
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  log('info', `${signal} received — shutting down gracefully…`);
  server.close(async () => {
    log('info', 'HTTP server closed');
    try {
      await mongoose.connection.close();
      log('info', 'MongoDB connection closed');
    } catch (e) { }
    process.exit(0);
  });
  setTimeout(() => {
    log('error', 'Force exit after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
server.listen(PORT, '0.0.0.0', () => {
  log('info', 'Starting NearMe server…');
  log('info', `Node ${process.version} | ENV=${process.env.NODE_ENV || 'development'} | LOG_LEVEL=${process.env.LOG_LEVEL || 'info'}`);
  log('info', `🚀 NearMe running on port ${PORT}`);
  log('info', `   Trust proxy: ${app.get('trust proxy')}`);
  log('info', `   Secure cookies: ${process.env.NODE_ENV === 'production'}`);
});
