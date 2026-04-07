const express = require('express');
const passport = require('passport');

const router = express.Router();

// ── Initiate Google OAuth flow ────────────────────────────────────────────────
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account',
}));

// ── Google OAuth callback ─────────────────────────────────────────────────────
router.get(
  '/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=oauth_failed' }),
  (req, res) => {
    // Redirect based on onboarding state
    if (!req.user.profileComplete) {
      return res.redirect('/onboarding');
    }
    res.redirect('/app');
  }
);

// ── Logout ────────────────────────────────────────────────────────────────────
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });
});

// ── Current session user ──────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { _id, name, email, avatar, profileComplete, isOnline, lastSeen } = req.user;
  res.json({ _id, name, email, avatar, profileComplete, isOnline, lastSeen });
});

module.exports = router;
