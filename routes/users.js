const express = require('express');
const router  = express.Router();
const User    = require('../models/User');

// ── Middleware ────────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip HTML/script tags and trim a string */
function sanitiseText(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>/g, '')   // strip tags
    .replace(/[<>]/g, '')      // strip stray brackets
    .trim()
    .slice(0, maxLen);
}

/** Clean an array of interest strings */
function sanitiseInterests(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(i => sanitiseText(String(i), 40))
    .filter(Boolean)
    .slice(0, 20);
}

/** Convert radius value to a clamped integer in metres */
function clampRadius(val) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return 5000;
  return Math.min(50000, Math.max(500, n));
}

const VALID_LOOKING_FOR = new Set(['friendship', 'networking', 'dating', 'collaboration', 'all']);

// ── POST /api/users/onboarding ───────────────────────────────────────────────
// Called once when a new user completes the onboarding flow.
// Also acts as "save profile edits" if profileComplete is already true —
// it will just update the fields without touching onboardedAt.
router.post('/onboarding', requireAuth, async (req, res) => {
  try {
    const { bio, interests, lookingFor, searchRadius, isVisible } = req.body;

    // — Validate —
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

    const updatePayload = {
      bio:             cleanBio,
      interests:       cleanInterests,
      lookingFor:      cleanLooking,
      searchRadius:    cleanRadius,
      isVisible:       cleanVisible,
      profileComplete: true,
    };

    // Only set onboardedAt the very first time
    if (isFirstTime) {
      updatePayload.onboardedAt = new Date();
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updatePayload },
      { new: true, runValidators: true }
    );

    return res.json({
      success:    true,
      firstTime:  isFirstTime,
      user: {
        id:          updatedUser._id,
        name:        updatedUser.name,
        bio:         updatedUser.bio,
        interests:   updatedUser.interests,
        lookingFor:  updatedUser.lookingFor,
        searchRadius:updatedUser.searchRadius,
        isVisible:   updatedUser.isVisible,
      }
    });

  } catch (err) {
    console.error('[onboarding]', err);
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message).join(' ');
      return res.status(400).json({ error: messages });
    }
    return res.status(500).json({ error: 'Failed to save profile. Please try again.' });
  }
});

// ── PUT /api/users/profile ────────────────────────────────────────────────────
// In-app profile edits (sidebar). Requires profile to already be complete.
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
      {
        $set: {
          bio:          cleanBio,
          interests:    cleanInterests,
          lookingFor:   cleanLooking,
          searchRadius: cleanRadius,
          isVisible:    cleanVisible,
        }
      },
      { new: true, runValidators: true }
    );

    return res.json({ success: true, user });

  } catch (err) {
    console.error('[profile update]', err);
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message).join(' ');
      return res.status(400).json({ error: messages });
    }
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ── PUT /api/users/location ───────────────────────────────────────────────────
router.put('/location', requireAuth, async (req, res) => {
  try {
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);

    if (isNaN(lat) || isNaN(lng)
      || lat < -90  || lat > 90
      || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Invalid coordinates.' });
    }

    const city    = sanitiseText(req.body.city    || '', 80);
    const country = sanitiseText(req.body.country || '', 60);

    await User.findByIdAndUpdate(req.user._id, {
      $set: {
        location: {
          type:        'Point',
          coordinates: [lng, lat],
          city,
          country
        },
        lastSeen: new Date(),
        isOnline: true
      }
    });

    return res.json({ success: true });

  } catch (err) {
    console.error('[location update]', err);
    return res.status(500).json({ error: 'Failed to update location.' });
  }
});

// ── GET /api/users/nearby ─────────────────────────────────────────────────────
router.get('/nearby', requireAuth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user._id)
      .select('location searchRadius');

    if (!currentUser?.location
      || (currentUser.location.coordinates[0] === 0
       && currentUser.location.coordinates[1] === 0)) {
      return res.json({ users: [] });
    }

    const radius         = currentUser.searchRadius || 5000;
    const activeWindow   = new Date(Date.now() - 5 * 60 * 1000); // last 5 min

    const nearbyUsers = await User.find({
      _id:            { $ne: req.user._id },
      isVisible:      true,
      profileComplete: true,
      lastSeen:       { $gte: activeWindow },
      location: {
        $near: {
          $geometry: {
            type:        'Point',
            coordinates: currentUser.location.coordinates
          },
          $maxDistance: radius
        }
      }
    })
    .select('name avatar bio interests lookingFor location lastSeen isOnline')
    .limit(50)
    .lean();

    return res.json({ users: nearbyUsers });

  } catch (err) {
    console.error('[nearby]', err);
    return res.status(500).json({ error: 'Failed to fetch nearby users.' });
  }
});

// ── GET /api/users/:id ────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    // Basic ObjectId length guard to avoid mongoose cast errors on bad input
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid user id.' });
    }

    const user = await User.findById(req.params.id)
      .select('name avatar bio interests lookingFor lastSeen isOnline')
      .lean();

    if (!user) return res.status(404).json({ error: 'User not found.' });

    return res.json(user);

  } catch (err) {
    console.error('[get user]', err);
    return res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

module.exports = router;
