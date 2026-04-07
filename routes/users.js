const express = require('express');
const User = require('../models/User');

const router = express.Router();

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

router.use(requireAuth);

// ── GET /api/users/me ─────────────────────────────────────────────────────────
// Returns the full profile of the authenticated user
router.get('/me', async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/users/me ───────────────────────────────────────────────────────
// Update profile (used during onboarding and settings)
router.patch('/me', async (req, res) => {
  const allowed = ['name', 'bio', 'interests'];
  const updates = {};

  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // Validate name
  if (updates.name !== undefined) {
    updates.name = String(updates.name).trim();
    if (!updates.name || updates.name.length > 100) {
      return res.status(400).json({ error: 'Name must be 1–100 characters' });
    }
  }

  // Validate bio
  if (updates.bio !== undefined) {
    updates.bio = String(updates.bio).trim();
    if (updates.bio.length > 300) {
      return res.status(400).json({ error: 'Bio must be under 300 characters' });
    }
  }

  // Validate interests
  if (updates.interests !== undefined) {
    if (!Array.isArray(updates.interests) || updates.interests.length > 20) {
      return res.status(400).json({ error: 'Interests must be an array of up to 20 items' });
    }
    updates.interests = updates.interests.map(i => String(i).trim()).filter(Boolean);
  }

  // Mark profile complete if name and bio are present
  if (updates.name || updates.bio) {
    const existing = await User.findById(req.user._id).lean();
    const mergedName = updates.name ?? existing?.name;
    const mergedBio  = updates.bio  ?? existing?.bio;
    if (mergedName && mergedBio) updates.profileComplete = true;
  }

  try {
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/users/nearby ─────────────────────────────────────────────────────
// Returns users within a given radius (default 5 km), sorted by distance
router.get('/nearby', async (req, res) => {
  const { lat, lng, radius = 5000, limit = 50 } = req.query;

  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  const radiusN = Math.min(parseInt(radius, 10), 50000); // cap at 50 km
  const limitN  = Math.min(parseInt(limit,  10), 100);

  if (isNaN(latN) || isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  try {
    const users = await User.find({
      _id: { $ne: req.user._id },
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [lngN, latN] },
          $maxDistance: radiusN,
        },
      },
    })
      .select('_id name avatar bio interests isOnline lastSeen location')
      .limit(limitN)
      .lean();

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/users/:id ────────────────────────────────────────────────────────
// Public profile of any user
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('_id name avatar bio interests isOnline lastSeen')
      .lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid user ID' });
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
