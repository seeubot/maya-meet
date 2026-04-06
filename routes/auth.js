const express = require('express');
const passport = require('passport');
const router = express.Router();

// Start Google OAuth
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google OAuth callback
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    // Check if profile is complete
    const user = req.user;
    if (!user.interests || user.interests.length === 0) {
      return res.redirect('/onboarding');
    }
    res.redirect('/app');
  }
);

// Logout
router.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) console.error(err);
    res.redirect('/');
  });
});

// Get current user
router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    avatar: req.user.avatar,
    bio: req.user.bio,
    interests: req.user.interests,
    lookingFor: req.user.lookingFor,
    searchRadius: req.user.searchRadius,
    isVisible: req.user.isVisible
  });
});

module.exports = router;
