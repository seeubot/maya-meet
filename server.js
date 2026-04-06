require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const passport   = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const morgan     = require('morgan');
const path       = require('path');
const fs         = require('fs');
const User       = require('./models/User');

// ─── Logger ───────────────────────────────────────────────────────────────────
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // debug | info | warn | error
const LEVELS    = { debug: 0, info: 1, warn: 2, error: 3 };

const ts  = () => new Date().toISOString();
const log = {
  debug: (...a) => LEVELS[LOG_LEVEL] <= 0 && console.debug(`[${ts()}] [DEBUG]`, ...a),
  info:  (...a) => LEVELS[LOG_LEVEL] <= 1 && console.log  (`[${ts()}] [INFO ]`, ...a),
  warn:  (...a) => LEVELS[LOG_LEVEL] <= 2 && console.warn (`[${ts()}] [WARN ]`, ...a),
  error: (...a) => LEVELS[LOG_LEVEL] <= 3 && console.error(`[${ts()}] [ERROR]`, ...a),
};

// ─── Logs directory ───────────────────────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ─── Bootstrap ────────────────────────────────────────────────────────────────
log.info('Starting NearMe server…');
log.info(`Node ${process.version} | ENV=${process.env.NODE_ENV || 'development'} | LOG_LEVEL=${LOG_LEVEL}`);

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.APP_URL || '*', methods: ['GET', 'POST'] }
});

// ─── HTTP request logging (morgan) ───────────────────────────────────────────
// Console: coloured one-liner per request
app.use(morgan((tokens, req, res) => {
  const status = tokens.status(req, res);
  const color  = status >= 500 ? '\x1b[31m'
               : status >= 400 ? '\x1b[33m'
               : status >= 300 ? '\x1b[36m'
               :                 '\x1b[32m';
  return [
    `[${ts()}] [HTTP ]`,
    req.method.padEnd(6),
    `${color}${status}\x1b[0m`,
    tokens.url(req, res),
    `${tokens['response-time'](req, res)}ms`,
    `ip=${tokens['remote-addr'](req, res)}`,
    req.user ? `user=${req.user._id}` : 'guest',
  ].join(' ');
}));

// File: full combined log
const accessLog = fs.createWriteStream(path.join(LOGS_DIR, 'access.log'), { flags: 'a' });
app.use(morgan('combined', { stream: accessLog }));

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://accounts.google.com"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc:      ["'self'", "data:", "https:", "blob:"],
      connectSrc:  ["'self'", "wss:", "ws:", "https:"],
      frameSrc:    ["'none'"],
    }
  }
}));

app.use(cors());

app.use(rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  validate:        { xForwardedForHeader: false },
  handler: (req, res) => {
    log.warn(`Rate limit exceeded — ip=${req.ip} path=${req.path}`);
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  }
}));

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Static files ─────────────────────────────────────────────────────────────
// Guard protected HTML pages from being served directly by express.static.
// Without this, /app.html and /onboarding.html bypass all route-level auth.
const PROTECTED_PAGES = ['/app.html', '/onboarding.html'];
app.use((req, res, next) => {
  if (PROTECTED_PAGES.includes(req.path)) {
    if (!req.isAuthenticated()) {
      log.warn(`Direct static access blocked — ${req.path} ip=${req.ip}`);
      return res.redirect('/');
    }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB ──────────────────────────────────────────────────────────────────
// Enable query-level debug logging when LOG_LEVEL=debug
mongoose.set('debug', (col, method, query) => {
  log.debug(`[Mongoose] ${col}.${method}`, JSON.stringify(query));
});

mongoose.connection.on('connected',    () => log.info ('✅ MongoDB connected'));
mongoose.connection.on('disconnected', () => log.warn ('⚠️  MongoDB disconnected'));
mongoose.connection.on('reconnected',  () => log.info ('🔄 MongoDB reconnected'));
mongoose.connection.on('error',       (e) => log.error('❌ MongoDB error:', e.message));

mongoose.connect(process.env.MONGODB_URI)
  .catch(err => {
    log.error('❌ MongoDB initial connection failed:', err.message);
    process.exit(1);
  });

// ─── Session ──────────────────────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'nearme_secret_dev',
  resave:            false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl:   process.env.MONGODB_URI,
    touchAfter: 24 * 3600,
  }),
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000
  }
}));

// ─── Passport ─────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.create({
        googleId: profile.id,
        email:    profile.emails[0].value,
        name:     profile.displayName,
        avatar:   profile.photos[0]?.value || ''
      });
      log.info(`New user created: id=${user._id} email=${user.email}`);
    } else {
      log.debug(`Existing user authenticated: id=${user._id} email=${user.email}`);
    }
    return done(null, user);
  } catch (err) {
    log.error('Google OAuth strategy error:', err.message);
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => {
  log.debug(`serializeUser id=${user._id}`);
  done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    if (!user) log.warn(`deserializeUser: no user found for id=${id}`);
    done(null, user);
  } catch (err) {
    log.error('deserializeUser error:', err.message);
    done(err, null);
  }
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth',      require('./routes/auth'));
app.use('/api/users', require('./routes/users'));

app.get('/', (req, res) => {
  log.debug(`GET / — authenticated=${req.isAuthenticated()}`);
  if (req.isAuthenticated()) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/onboarding', (req, res) => {
  if (!req.isAuthenticated()) {
    log.warn(`/onboarding unauthenticated access — ip=${req.ip}`);
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'));
});

app.get('/app', (req, res) => {
  if (!req.isAuthenticated()) {
    log.warn(`/app unauthenticated access — ip=${req.ip}`);
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  log.warn(`404 — ${req.method} ${req.originalUrl} ip=${req.ip}`);
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  log.error(`Unhandled error — ${req.method} ${req.originalUrl}`);
  log.error(`  status  : ${status}`);
  log.error(`  message : ${err.message}`);
  if (process.env.NODE_ENV !== 'production') log.error(`  stack   :\n${err.stack}`);

  fs.appendFile(
    path.join(LOGS_DIR, 'error.log'),
    `[${ts()}] ${req.method} ${req.originalUrl} | ${status} | ${err.message}\n${err.stack}\n\n`,
    () => {}
  );

  res.status(status).json({
    error: status < 500 ? err.message : 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const onlineUsers = new Map();

io.on('connection', (socket) => {
  log.info(`Socket connected    id=${socket.id} ip=${socket.handshake.address}`);

  socket.on('user:join', async (userId) => {
    try {
      onlineUsers.set(socket.id, userId);
      await User.findByIdAndUpdate(userId, { isOnline: true, lastSeen: new Date() });
      io.emit('user:online', { userId });
      log.info(`user:join  userId=${userId} socketId=${socket.id}`);
    } catch (err) {
      log.error(`user:join error — userId=${userId}: ${err.message}`);
    }
  });

  socket.on('user:location', async ({ userId, lat, lng }) => {
    try {
      if (!userId || lat == null || lng == null) {
        log.warn(`user:location bad payload — socketId=${socket.id}`, { userId, lat, lng });
        return;
      }
      await User.findByIdAndUpdate(userId, {
        location: { type: 'Point', coordinates: [lng, lat] },
        lastSeen: new Date(),
        isOnline: true
      });
      socket.broadcast.emit('user:moved', { userId, lat, lng });
      log.debug(`user:location userId=${userId} lat=${lat} lng=${lng}`);
    } catch (err) {
      log.error(`user:location error — userId=${userId}: ${err.message}`);
    }
  });

  socket.on('disconnect', async (reason) => {
    const userId = onlineUsers.get(socket.id);
    log.info(`Socket disconnected id=${socket.id} reason=${reason}${userId ? ` userId=${userId}` : ''}`);
    if (userId) {
      try {
        onlineUsers.delete(socket.id);
        await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });
        io.emit('user:offline', { userId });
      } catch (err) {
        log.error(`disconnect cleanup error — userId=${userId}: ${err.message}`);
      }
    }
  });

  socket.on('error', (err) => {
    log.error(`Socket error — id=${socket.id}: ${err.message}`);
  });
});

// ─── Process safety nets ──────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled Promise Rejection:', reason);
  fs.appendFile(
    path.join(LOGS_DIR, 'error.log'),
    `[${ts()}] UnhandledRejection: ${reason}\n\n`,
    () => {}
  );
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught Exception — shutting down:', err.message);
  log.error(err.stack);
  fs.appendFileSync(path.join(LOGS_DIR, 'error.log'), `[${ts()}] UncaughtException: ${err.stack}\n\n`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  log.info('SIGTERM received — shutting down gracefully…');
  server.close(() => {
    log.info('HTTP server closed');
    mongoose.connection.close(false, () => {
      log.info('MongoDB connection closed');
      process.exit(0);
    });
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  log.info(`🚀 NearMe running on port ${PORT}`);
  log.info(`   Logs dir       : ${LOGS_DIR}`);
  log.info(`   Trust proxy    : ${app.get('trust proxy')}`);
  log.info(`   Secure cookies : ${process.env.NODE_ENV === 'production'}`);
});
