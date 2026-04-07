const express  = require('express');
const passport = require('passport');
const User     = require('../models/User');
const router   = express.Router();

// ── Google OAuth start ────────────────────────────────────────────────────────
router.get('/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',   // always show account picker
  })
);

// ── Google OAuth callback ─────────────────────────────────────────────────────
router.get('/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/?error=auth_failed',
    session: true,
  }),
  async (req, res) => {
    try {
      // Re-fetch fresh user from DB — the deserialized req.user might be a
      // cached copy from before a profileComplete update.
      const freshUser = await User.findById(req.user._id).lean();
      if (!freshUser) return res.redirect('/?error=user_not_found');

      // Replace the session user with the fresh copy so every subsequent
      // req.user.profileComplete check in this session is accurate.
      req.user = freshUser;
      await new Promise((ok, fail) =>
        req.session.save(err => err ? fail(err) : ok())
      );

      const dest = freshUser.profileComplete ? '/app' : '/onboarding';
      console.log(`[INFO ] [auth] OAuth callback — userId=${freshUser._id} profileComplete=${freshUser.profileComplete} → ${dest}`);
      return res.redirect(dest);
    } catch (err) {
      console.error('[ERROR] [auth] callback error', err.message);
      return res.redirect('/?error=server_error');
    }
  }
);

// ── Logout ────────────────────────────────────────────────────────────────────
router.get('/logout', (req, res, next) => {
  const uid = req.user?._id;
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      console.log(`[INFO ] [auth] logout — userId=${uid}`);
      res.redirect('/');
    });
  });
});

// ── GET /auth/me — lightweight session check used by frontend ─────────────────
router.get('/me', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Always return fresh data — never trust the stale in-session copy for
  // fields the user may have just updated (bio, interests, profileComplete, etc.)
  try {
    const user = await User.findById(req.user._id)
      .select('name email avatar bio interests lookingFor searchRadius isVisible profileComplete')
      .lean();

    if (!user) return res.status(401).json({ error: 'User not found' });

    return res.json(user);
  } catch (err) {
    console.error('[ERROR] /auth/me', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
