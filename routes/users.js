const express = require('express');
const router = express.Router();
const User = require('../models/User');

// Logger
const log = (level, msg, meta = {}) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] [users] ${msg}`, Object.keys(meta).length ? meta : '');
};

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

// Shared validation middleware
const validateProfileFields = (req, res, next) => {
  const { bio, interests, lookingFor, searchRadius, isVisible } = req.body;

  const cleanBio = sanitiseText(bio, 200);
  if (!cleanBio || cleanBio.length < 10) {
    return res.status(400).json({ error: 'Bio must be at least 10 characters.' });
  }

  const cleanInterests = sanitiseInterests(interests);
  if (cleanInterests.length < 2) {
    return res.status(400).json({ error: 'Please select at least 2 interests.' });
  }

  req.cleanData = {
    bio: cleanBio,
    interests: cleanInterests,
    lookingFor: VALID_LOOKING_FOR.has(lookingFor) ? lookingFor : 'all',
    searchRadius: clampRadius(searchRadius),
    isVisible: typeof isVisible === 'boolean' ? isVisible : true
  };

  next();
};

// ── POST /api/users/onboarding ────────────────────────────────────────────────
router.post('/onboarding', requireAuth, validateProfileFields, async (req, res) => {
  try {
    const { bio, interests, lookingFor, searchRadius, isVisible } = req.cleanData;
    const isFirstTime = !req.user.profileComplete;

    const updatePayload = {
      bio, interests, lookingFor, searchRadius, isVisible,
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

    // Refresh session
    await new Promise((resolve, reject) => {
      req.login(updatedUser, err => err ? reject(err) : resolve());
    });

    log('info', 'Onboarding saved', { userId: updatedUser._id, firstTime: isFirstTime });

    return res.json({
      success: true,
      firstTime: isFirstTime,
      user: {
        id: updatedUser._id,
        name: updatedUser.name,
        bio: updatedUser.bio,
        interests: updatedUser.interests,
        lookingFor: updatedUser.lookingFor,
        searchRadius: updatedUser.searchRadius,
        isVisible: updatedUser.isVisible,
        profileComplete: updatedUser.profileComplete,
      }
    });

  } catch (err) {
    log('error', 'Onboarding error', { error: err.message });
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors).map(e => e.message).join(' ');
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: 'Failed to save profile. Please try again.' });
  }
});

// ── PUT /api/users/profile ────────────────────────────────────────────────────
router.put('/profile', requireAuth, validateProfileFields, async (req, res) => {
  try {
    const { bio, interests, lookingFor, searchRadius, isVisible } = req.cleanData;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { bio, interests, lookingFor, searchRadius, isVisible } },
      { new: true, runValidators: true, lean: true }
    ).select('name bio interests lookingFor searchRadius isVisible');

    log('info', 'Profile updated', { userId: user._id });
    return res.json({ success: true, user });

  } catch (err) {
    log('error', 'Profile update error', { error: err.message });
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
          city: sanitiseText(req.body.city || '', 80),
          country: sanitiseText(req.body.country || '', 60),
        },
        lastSeen: new Date(),
        isOnline: true,
      }
    });

    return res.json({ success: true });

  } catch (err) {
    log('error', 'Location update error', { error: err.message });
    return res.status(500).json({ error: 'Failed to update location.' });
  }
});

// ── GET /api/users/nearby ─────────────────────────────────────────────────────
router.get('/nearby', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const me = await User.findById(req.user._id)
      .select('location searchRadius lookingFor')
      .lean();

    const coords = me?.location?.coordinates;
    if (!coords || coords.length !== 2 || (coords[0] === 0 && coords[1] === 0)) {
      return res.json({ users: [], pagination: { page, limit, total: 0, message: 'Location not set yet' } });
    }

    const radius = me.searchRadius || 5000;
    const activeAfter = new Date(Date.now() - 5 * 60 * 1000);

    const filter = {
      _id: { $ne: req.user._id },
      isVisible: true,
      profileComplete: true,
      lastSeen: { $gte: activeAfter },
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: coords },
          $maxDistance: radius,
        }
      }
    };

    // Apply lookingFor filter if user has a specific preference
    if (me.lookingFor && me.lookingFor !== 'all') {
      filter.lookingFor = me.lookingFor;
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('name avatar bio interests lookingFor location.city location.country lastSeen isOnline')
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter)
    ]);

    return res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasMore: skip + limit < total
      }
    });

  } catch (err) {
    log('error', 'Nearby query error', { error: err.message });
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
      .select('name avatar bio interests lookingFor lastSeen isOnline location.city location.country')
      .lean();

    if (!user) return res.status(404).json({ error: 'User not found.' });
    
    // Don't return exact location coordinates for privacy
    delete user.location;
    
    return res.json(user);

  } catch (err) {
    log('error', 'Get user error', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

module.exports = router;
