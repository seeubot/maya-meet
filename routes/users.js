const express = require('express');
const router = express.Router();
const User = require('../models/User');

// ─── Auth middleware ───────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ─── GET /me ──────────────────────────────────────────────────────────────────
// Returns the authenticated user's own full profile.
// NOTE: Must be defined before /:id to avoid "me" being treated as a Mongo ID.
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('name avatar email bio interests lookingFor searchRadius isVisible lastSeen isOnline');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// ─── PUT /profile ─────────────────────────────────────────────────────────────
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { bio, interests, lookingFor, searchRadius, isVisible } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { bio, interests, lookingFor, searchRadius, isVisible },
      { new: true, runValidators: true }
    ).select('-__v');
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─── PUT /location ────────────────────────────────────────────────────────────
// FIX: city/country must NOT be nested inside the GeoJSON Point object.
// GeoJSON only allows { type, coordinates } — extra fields break $near queries.
router.put('/location', requireAuth, async (req, res) => {
  try {
    const { lat, lng, city, country } = req.body;
    if (lat == null || lng == null) {
      return res.status(400).json({ error: 'Coordinates required' });
    }

    await User.findByIdAndUpdate(req.user._id, {
      location: {
        type: 'Point',
        coordinates: [parseFloat(lng), parseFloat(lat)]
      },
      locationCity:    city    || '',   // stored at top level, not inside GeoJSON
      locationCountry: country || '',
      lastSeen:        new Date(),
      isOnline:        true
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// ─── GET /nearby ──────────────────────────────────────────────────────────────
// FIX 1: Extended activity window from 5 min → 30 min (5 min was too aggressive).
// FIX 2: Coordinates are NOT returned to the caller – only city/country are exposed.
router.get('/nearby', requireAuth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user._id);

    if (!currentUser.location?.coordinates?.length ||
        currentUser.location.coordinates[0] === 0) {
      return res.json({ users: [] });
    }

    const radius         = currentUser.searchRadius || 5000;
    const thirtyMinAgo   = new Date(Date.now() - 30 * 60 * 1000);

    const nearbyUsers = await User.find({
      _id:      { $ne: req.user._id },
      isVisible: true,
      lastSeen: { $gte: thirtyMinAgo },
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: currentUser.location.coordinates
          },
          $maxDistance: radius
        }
      }
    })
    // FIX 3: Exclude exact coordinates from results — return city/country only.
    .select('name avatar bio interests lookingFor locationCity locationCountry lastSeen isOnline')
    .limit(50);

    res.json({ users: nearbyUsers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch nearby users' });
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────
// FIX: Validate that :id is a valid ObjectId before querying to avoid a
// CastError when an invalid string (e.g. a misrouted path) hits this route.
// Coordinates are excluded here too.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!req.params.id.match(/^[a-f\d]{24}$/i)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const user = await User.findById(req.params.id)
      .select('name avatar bio interests lookingFor locationCity locationCountry lastSeen isOnline');

    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

module.exports = router;
