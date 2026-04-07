const express = require('express');
const router  = express.Router();
const User    = require('../models/User');

// ── Auth middleware ───────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'Unauthorized' });
};

// ── Sanitisation helpers ──────────────────────────────────────────────────────
function sanitiseText(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, maxLen);
}

function sanitiseInterests(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(
    arr.map(i => sanitiseText(String(i), 40)).filter(Boolean)
  )].slice(0, 20);
}

function clampRadius(val) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return 5000;
  return Math.min(50000, Math.max(500, n));
}

const VALID_LOOKING_FOR = new Set(['friendship', 'networking', 'dating', 'collaboration', 'all']);

// ── POST /api/users/onboarding ────────────────────────────────────────────────
// Completes first-time setup OR re-saves profile edits from the onboarding page.
// KEY FIX: after saving, we re-fetch the user and write it back into req.session
// so that the very next req.user.profileComplete is true — no stale cache.
router.post('/onboarding', requireAuth, async (req, res) => {
  try {
    const { bio, interests, lookingFor, searchRadius, isVisible } = req.body;

    // ── Validate ─────────────────────────────────────────────────────────────
    const cleanBio = sanitiseText(bio, 200);
    if (!cleanBio || cleanBio.length < 10) {
      return res.status(400).json({ error: 'Bio must be at least 10 characters.' });
    }

    const cleanInterests = sanitiseInterests(interests);
    if (cleanInterests.length < 2) {
      return res.status(400).json({ error: 'Please select at least 2 interests.' });
    }

    const cleanLooking = VALID_LOOKING_FOR.has(lookingFor) ? lookingFor : 'all';
    const cleanRadius  = clampRadius(searchRadius);
    const cleanVisible = typeof isVisible === 'boolean' ? isVisible : true;

    const isFirstTime = !req.user.profileComplete;

    // ── Persist ───────────────────────────────────────────────────────────────
    const updatePayload = {
      bio:             cleanBio,
      interests:       cleanInterests,
      lookingFor:      cleanLooking,
      searchRadius:    cleanRadius,
      isVisible:       cleanVisible,
      profileComplete: true,
    };
    if (isFirstTime) {
      updatePayload.onboardedAt = new Date();
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updatePayload },
      { new: true, runValidators: true, lean: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // ── Refresh session ───────────────────────────────────────────────────────
    // This is the critical fix: write the updated user back into the Passport
    // session so that req.user.profileComplete is true on the VERY NEXT request
    // (i.e. the GET /app that follows the redirect from the frontend).
    await new Promise((resolve, reject) => {
      req.login(updatedUser, err => err ? reject(err) : resolve());
    });

    console.log(`[INFO ] [onboarding] saved — userId=${updatedUser._id} firstTime=${isFirstTime} profileComplete=true`);

    return res.json({
      success:   true,
      firstTime: isFirstTime,
      user: {
        id:           updatedUser._id,
        name:         updatedUser.name,
        bio:          updatedUser.bio,
        interests:    updatedUser.interests,
        lookingFor:   updatedUser.lookingFor,
        searchRadius: updatedUser.searchRadius,
        isVisible:    updatedUser.isVisible,
        profileComplete: updatedUser.profileComplete,
      }
    });

  } catch (err) {
    console.error('[ERROR] [onboarding]', err.message);
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors).map(e => e.message).join(' ');
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: 'Failed to save profile. Please try again.' });
  }
});

// ── PUT /api/users/profile ────────────────────────────────────────────────────
// In-app sidebar edits — profile must already be complete.
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { bio, interests, lookingFor, searchRadius, isVisible } = req.body;

    const cleanBio       = sanitiseText(bio, 200);
    const cleanInterests = sanitiseInterests(interests);
    const cleanLooking   = VALID_LOOKING_FOR.has(lookingFor) ? lookingFor : 'all';
    const cleanRadius    = clampRadius(searchRadius);
    const cleanVisible   = typeof isVisible === 'boolean' ? isVisible : true;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { bio: cleanBio, interests: cleanInterests, lookingFor: cleanLooking, searchRadius: cleanRadius, isVisible: cleanVisible } },
      { new: true, runValidators: true, lean: true }
    );

    return res.json({ success: true, user });

  } catch (err) {
    console.error('[ERROR] [profile update]', err.message);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(' ') });
    }
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ── PUT /api/users/location ───────────────────────────────────────────────────
router.put('/location', requireAuth, async (req, res) => {
  try {
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates.' });
    }

    await User.findByIdAndUpdate(req.user._id, {
      $set: {
        location: {
          type: 'Point',
          coordinates: [lng, lat],
          city:    sanitiseText(req.body.city    || '', 80),
          country: sanitiseText(req.body.country || '', 60),
        },
        lastSeen: new Date(),
        isOnline: true,
      }
    });

    return res.json({ success: true });

  } catch (err) {
    console.error('[ERROR] [location]', err.message);
    return res.status(500).json({ error: 'Failed to update location.' });
  }
});

// ── GET /api/users/nearby ─────────────────────────────────────────────────────
router.get('/nearby', requireAuth, async (req, res) => {
  try {
    const me = await User.findById(req.user._id).select('location searchRadius').lean();

    const coords = me?.location?.coordinates;
    if (!coords || (coords[0] === 0 && coords[1] === 0)) {
      return res.json({ users: [] });
    }

    const radius      = me.searchRadius || 5000;
    const activeAfter = new Date(Date.now() - 5 * 60 * 1000);

    const nearby = await User.find({
      _id:             { $ne: req.user._id },
      isVisible:       true,
      profileComplete: true,
      lastSeen:        { $gte: activeAfter },
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: coords },
          $maxDistance: radius,
        }
      }
    })
    .select('name avatar bio interests lookingFor location lastSeen isOnline')
    .limit(50)
    .lean();

    return res.json({ users: nearby });

  } catch (err) {
    console.error('[ERROR] [nearby]', err.message);
    return res.status(500).json({ error: 'Failed to fetch nearby users.' });
  }
});

// ── GET /api/users/:id ────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user id.' });
    }
    const user = await User.findById(req.params.id)
      .select('name avatar bio interests lookingFor lastSeen isOnline')
      .lean();

    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json(user);

  } catch (err) {
    console.error('[ERROR] [get user]', err.message);
    return res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

module.exports = router;
