const express  = require('express');
const passport = require('passport');
const router   = express.Router();

// Re-use the same logger pattern as server.js
const ts  = () => new Date().toISOString();
const log = {
  info:  (...a) => console.log  (`[${ts()}] [INFO ] [auth]`, ...a),
  warn:  (...a) => console.warn (`[${ts()}] [WARN ] [auth]`, ...a),
  error: (...a) => console.error(`[${ts()}] [ERROR] [auth]`, ...a),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
// A profile is considered complete when the user has explicitly saved
// onboarding data. Checking onboardingComplete first (fastest), then
// falling back to field inspection for users created before that flag existed.
function isProfileComplete(user) {
  if (user.onboardingComplete === true) return true;
  return !!(user.bio || (user.interests && user.interests.length > 0));
}

// ─── Google OAuth – start ─────────────────────────────────────────────────────
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// ─── Google OAuth – callback ──────────────────────────────────────────────────
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    const user      = req.user;
    const complete  = isProfileComplete(user);
    const dest      = complete ? '/app' : '/onboarding';
    log.info(`OAuth callback — userId=${user._id} profileComplete=${complete} → ${dest}`);
    res.redirect(dest);
  }
);

// ─── Logout ───────────────────────────────────────────────────────────────────
// FIX: req.logout() alone only clears req.user — it does NOT destroy the
// session cookie. Calling req.session.destroy() ensures the session is fully
// invalidated server-side so the cookie can't be replayed.
router.get('/logout', (req, res, next) => {
  const userId = req.user?._id;
  req.logout((err) => {
    if (err) {
      log.error(`logout error — userId=${userId}:`, err.message);
      return next(err);
    }
    req.session.destroy((destroyErr) => {
      if (destroyErr) {
        log.error(`session destroy error — userId=${userId}:`, destroyErr.message);
      }
      res.clearCookie('connect.sid');
      log.info(`User logged out — userId=${userId}`);
      res.redirect('/');
    });
  });
});

// ─── GET /me ──────────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const u = req.user;
  res.json({
    id:              u._id,
    name:            u.name,
    email:           u.email,
    avatar:          u.avatar,
    bio:             u.bio,
    interests:       u.interests,
    lookingFor:      u.lookingFor,
    searchRadius:    u.searchRadius,
    isVisible:       u.isVisible,
    locationCity:    u.locationCity,
    locationCountry: u.locationCountry,
  });
});

module.exports = router;
