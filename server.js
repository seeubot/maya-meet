require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const passport   = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const User       = require('./models/User');

// ── Logger ────────────────────────────────────────────────────────────────────
const LEVELS = { error:0, warn:1, info:2, http:3, debug:4 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? 2;

function log(level, msg, meta = {}) {
  if ((LEVELS[level] ?? 99) > LOG_LEVEL) return;
  const ts    = new Date().toISOString();
  const label = level.toUpperCase().padEnd(5);
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${ts}] [${label}] ${msg}${extra}`);
}

// ── App setup ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.APP_URL || '*', methods: ['GET','POST'] }
});

app.set('trust proxy', 1);

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:"],
      frameSrc:   ["'none'"],
    }
  }
}));
app.use(cors({ origin: process.env.APP_URL || '*', credentials: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false }));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// ── Request logger ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms   = Date.now() - start;
    const uid  = req.user?._id?.toString() ?? 'guest';
    const code = res.statusCode;
    log('http', `${req.method.padEnd(6)} ${code} ${req.path}`, { ms, ip: req.ip, user: uid });
  });
  next();
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => log('info', '✅ MongoDB connected'))
  .catch(err => log('error', '❌ MongoDB connection failed', { err: err.message }));

mongoose.connection.on('disconnected', () => log('warn', '⚠️  MongoDB disconnected'));
mongoose.connection.on('reconnected',  () => log('info', '✅ MongoDB reconnected'));

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessionMiddleware = session({
  secret:            process.env.SESSION_SECRET || 'nearme_dev_secret_change_in_prod',
  resave:            false,
  saveUninitialized: false,
  store:             MongoStore.create({ mongoUrl: process.env.MONGODB_URI, ttl: 7 * 24 * 3600 }),
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  }
});
app.use(sessionMiddleware);

// ── Passport ──────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email  = profile.emails?.[0]?.value;
    const avatar = profile.photos?.[0]?.value || '';

    // Upsert — always return the freshest DB copy so profileComplete is accurate
    let user = await User.findOneAndUpdate(
      { googleId: profile.id },
      { $setOnInsert: { googleId: profile.id, email, name: profile.displayName, avatar } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const isNew = !user.createdAt || (Date.now() - user.createdAt.getTime() < 5000);
    if (isNew) log('info', 'New user created', { id: user._id, email });

    return done(null, user);
  } catch (err) {
    log('error', 'OAuth strategy error', { err: err.message });
    return done(err, null);
  }
}));

// Serialize/deserialize — always re-fetch from DB so the session reflects DB truth
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
  if (!req.isAuthenticated())      return res.redirect('/');
  if (!req.user.profileComplete)   return res.redirect('/onboarding');
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',      require('./routes/auth'));
app.use('/api/users', require('./routes/users'));

// Landing — redirect authenticated users based on onboarding state
app.get('/', (req, res) => {
  if (!req.isAuthenticated()) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  if (!req.user.profileComplete) return res.redirect('/onboarding');
  return res.redirect('/app');
});

// Onboarding — must be logged in; if already complete, redirect to /app
app.get('/onboarding', requireAuth, (req, res) => {
  // Always show the page — users can revisit to edit profile
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'));
});

// App — must be logged in AND have completed onboarding
app.get('/app', requireOnboarded, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
// Share express sessions with socket.io
const wrap = mw => (socket, next) => mw(socket.request, {}, next);
io.use(wrap(sessionMiddleware));
io.use(wrap(passport.initialize()));
io.use(wrap(passport.session()));

// Only allow authenticated sockets
io.use((socket, next) => {
  if (socket.request.user) return next();
  next(new Error('Unauthorized'));
});

const onlineUsers = new Map(); // socketId → userId string

io.on('connection', (socket) => {
  const userId = socket.request.user?._id?.toString();
  log('info', 'Socket connected', { id: socket.id, ip: socket.handshake.address });

  socket.on('user:join', async (uid) => {
    // Trust the session user, not the client-supplied uid
    const safeId = userId || uid;
    onlineUsers.set(socket.id, safeId);
    try {
      await User.findByIdAndUpdate(safeId, { isOnline: true, lastSeen: new Date() });
      io.emit('user:online', { userId: safeId });
      log('info', 'user:join', { userId: safeId, socketId: socket.id });
    } catch(e) { log('warn', 'user:join DB error', { err: e.message }); }
  });

  socket.on('user:location', async ({ lat, lng }) => {
    if (!userId) return;
    const latN = parseFloat(lat), lngN = parseFloat(lng);
    if (isNaN(latN) || isNaN(lngN)) return;
    try {
      await User.findByIdAndUpdate(userId, {
        location: { type:'Point', coordinates:[lngN, latN] },
        lastSeen: new Date(), isOnline: true
      });
      socket.broadcast.emit('user:moved', { userId, lat: latN, lng: lngN });
    } catch(e) { log('warn', 'user:location socket error', { err: e.message }); }
  });

  socket.on('disconnect', async (reason) => {
    const uid = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (uid) {
      try {
        await User.findByIdAndUpdate(uid, { isOnline: false, lastSeen: new Date() });
        io.emit('user:offline', { userId: uid });
      } catch(e) { /* ignore */ }
    }
    log('info', 'Socket disconnected', { id: socket.id, reason, userId: uid });
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
    } catch(e) {}
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
server.listen(PORT, '0.0.0.0', () => {
  log('info', 'Starting NearMe server…');
  log('info', `Node ${process.version} | ENV=${process.env.NODE_ENV} | LOG_LEVEL=${process.env.LOG_LEVEL||'info'}`);
  log('info', `🚀 NearMe running on port ${PORT}`);
  log('info', `   Trust proxy    : ${app.get('trust proxy')}`);
  log('info', `   Secure cookies : ${process.env.NODE_ENV === 'production'}`);
});
