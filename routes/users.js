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
router.patch('/me', async (req, res) => {
  const allowed = ['name', 'bio', 'interests'];
  const updates = {};

  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (updates.name !== undefined) {
    updates.name = String(updates.name).trim();
    if (!updates.name || updates.name.length > 100) {
      return res.status(400).json({ error: 'Name must be 1–100 characters' });
    }
  }

  if (updates.bio !== undefined) {
    updates.bio = String(updates.bio).trim();
    if (updates.bio.length > 300) {
      return res.status(400).json({ error: 'Bio must be under 300 characters' });
    }
  }

  if (updates.interests !== undefined) {
    if (!Array.isArray(updates.interests) || updates.interests.length > 20) {
      return res.status(400).json({ error: 'Interests must be an array of up to 20 items' });
    }
    updates.interests = updates.interests.map(i => String(i).trim()).filter(Boolean);
  }

  try {
    const existing = await User.findById(req.user._id).lean();
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const mergedName = (updates.name ?? existing.name ?? '').trim();
    updates.profileComplete = !!mergedName;
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
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
// FIX 1: validate radius/limit for NaN before using them
// FIX 2: filter profileComplete:true so half-onboarded users don't appear
router.get('/nearby', async (req, res) => {
  const { lat, lng, radius, limit } = req.query;

  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);

  const rawRadius = parseInt(radius, 10);
  const rawLimit  = parseInt(limit,  10);
  const radiusN   = Math.min(isNaN(rawRadius) ? 5000 : rawRadius, 50000);
  const limitN    = Math.min(isNaN(rawLimit)  ? 50   : rawLimit,  100);

  if (isNaN(latN) || isNaN(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  try {
    const users = await User.find({
      _id: { $ne: req.user._id },
      profileComplete: true,
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
