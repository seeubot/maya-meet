const express = require('express');
const router = express.Router();
const User = require('../models/User');

// Auth middleware
const requireAuth = (req, res, next) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// Update profile
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { bio, interests, lookingFor, searchRadius, isVisible } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { bio, interests, lookingFor, searchRadius, isVisible },
      { new: true, runValidators: true }
    );
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Update location
router.put('/location', requireAuth, async (req, res) => {
  try {
    const { lat, lng, city, country } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'Coordinates required' });

    await User.findByIdAndUpdate(req.user._id, {
      location: {
        type: 'Point',
        coordinates: [parseFloat(lng), parseFloat(lat)],
        city: city || '',
        country: country || ''
      },
      lastSeen: new Date(),
      isOnline: true
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Get nearby users
router.get('/nearby', requireAuth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user._id);
    if (!currentUser.location || currentUser.location.coordinates[0] === 0) {
      return res.json({ users: [] });
    }

    const radius = currentUser.searchRadius || 5000;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const nearbyUsers = await User.find({
      _id: { $ne: req.user._id },
      isVisible: true,
      lastSeen: { $gte: fiveMinutesAgo },
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: currentUser.location.coordinates
          },
          $maxDistance: radius
        }
      }
    }).select('name avatar bio interests lookingFor location lastSeen isOnline').limit(50);

    res.json({ users: nearbyUsers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch nearby users' });
  }
});

// Get a single user profile
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('name avatar bio interests lookingFor location lastSeen isOnline');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

module.exports = router;
