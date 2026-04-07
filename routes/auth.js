const express = require('express');
const passport = require('passport');
const User = require('../models/User');
const router = express.Router();

// Logger
const log = (level, msg, meta = {}) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] [auth] ${msg}`, Object.keys(meta).length ? meta : '');
};

// Auth middleware for API routes
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
};

// ── Google OAuth start ────────────────────────────────────────────────────────
router.get('/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
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
      const freshUser = await User.findById(req.user._id).lean();
      if (!freshUser) {
        return res.redirect('/?error=user_not_found');
      }

      req.user = freshUser;

      // Save session with error handling
      await new Promise((resolve, reject) => {
        req.session.save(err => err ? reject(err) : resolve());
      });

      const dest = freshUser.profileComplete ? '/app' : '/onboarding';
      log('info', 'OAuth callback successful', {
        userId: freshUser._id,
        profileComplete: freshUser.profileComplete,
        destination: dest
      });

      return res.redirect(dest);
    } catch (err) {
      log('error', 'OAuth callback error', { error: err.message });
      return res.redirect('/?error=server_error');
    }
  }
);

// ── Logout (POST for CSRF protection) ─────────────────────────────────────────
router.post('/logout', (req, res, next) => {
  const uid = req.user?._id;

  req.logout(err => {
    if (err) return next(err);

    req.session.destroy((sessionErr) => {
      if (sessionErr) log('error', 'Session destroy error', { error: sessionErr.message });
      res.clearCookie('connect.sid');
      log('info', 'User logged out', { userId: uid });
      res.status(200).json({ success: true });
    });
  });
});

// GET logout redirects to home (backward compatibility)
router.get('/logout', (req, res) => {
  res.redirect('/');
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  try {
    const user = await User.findById(req.user._id)
      .select('name email avatar bio interests lookingFor searchRadius isVisible profileComplete location.city location.country')
      .lean();

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (err) {
    log('error', '/auth/me failed', { error: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /auth/me — update user profile ──────────────────────────────────────
router.patch('/me', requireAuth, async (req, res) => {
  const allowedUpdates = ['bio', 'interests', 'lookingFor', 'searchRadius', 'isVisible', 'profileComplete', 'name'];
  const updates = {};

  for (const field of allowedUpdates) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  try {
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('name email avatar bio interests lookingFor searchRadius isVisible profileComplete');

    res.json(user);
  } catch (err) {
    log('error', 'PATCH /auth/me failed', { error: err.message });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(' ') });
    }
    res.status(500).json({ error: 'Update failed' });
  }
});

module.exports = router;
