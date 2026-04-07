const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // ── Identity ──────────────────────────────────────────
  googleId: { type: String, required: true, unique: true, index: true },
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:     { type: String, required: true, trim: true },
  avatar:   { type: String, default: '' },

  // ── Profile ───────────────────────────────────────────
  bio: {
    type: String, default: '', trim: true,
    maxlength: [200, 'Bio cannot exceed 200 characters']
  },
  interests: {
    type: [{ type: String, trim: true, maxlength: 40 }],
    default: [],
    validate: {
      validator: v => v.length <= 20,
      message: 'You can have at most 20 interests'
    }
  },
  lookingFor: {
    type: String,
    enum: ['friendship', 'networking', 'dating', 'collaboration', 'all'],
    default: 'all'
  },

  // ── Onboarding state ──────────────────────────────────
  profileComplete: { type: Boolean, default: false },
  onboardedAt:     { type: Date, default: null },

  // ── Location ──────────────────────────────────────────
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [lng, lat]
      default: [0, 0]
    },
    city:    { type: String, default: '' },
    country: { type: String, default: '' }
  },

  // ── Presence & settings ───────────────────────────────
  isVisible:    { type: Boolean, default: true },
  lastSeen:     { type: Date, default: Date.now },
  isOnline:     { type: Boolean, default: false },
  searchRadius: {
    type: Number, default: 5000,
    min: [500,   'Search radius must be at least 500m'],
    max: [50000, 'Search radius cannot exceed 50km']
  },

  createdAt: { type: Date, default: Date.now }
});

// Geo index for $near queries
userSchema.index({ location: '2dsphere' });

// Compound index for the common nearby query
userSchema.index({ isVisible: 1, lastSeen: 1 });

module.exports = mongoose.model('User', userSchema);
