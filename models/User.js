const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email:    { type: String, required: true, unique: true },
  name:     { type: String, required: true },
  avatar:   { type: String, default: '' },

  // ─── Profile ───────────────────────────────────────────────────────────────
  bio:        { type: String, default: '', maxlength: 200 },
  interests:  [{ type: String, trim: true }],
  lookingFor: {
    type:    String,
    enum:    ['friendship', 'networking', 'dating', 'collaboration', 'all'],
    default: 'all'
  },

  // ─── Location ──────────────────────────────────────────────────────────────
  // FIX: city/country must NOT live inside the GeoJSON object.
  // MongoDB's 2dsphere index only accepts { type, coordinates } inside location.
  // Extra fields silently break $near queries and corrupt the index.
  location: {
    type: {
      type:    String,
      enum:    ['Point'],
      default: 'Point'
    },
    coordinates: {
      type:    [Number], // [lng, lat]
      default: [0, 0]
    }
  },
  locationCity:    { type: String, default: '' }, // stored at top level, not in GeoJSON
  locationCountry: { type: String, default: '' },

  // ─── Visibility ────────────────────────────────────────────────────────────
  isVisible: { type: Boolean, default: true },
  lastSeen:  { type: Date,    default: Date.now },
  isOnline:  { type: Boolean, default: false },

  // ─── Settings ──────────────────────────────────────────────────────────────
  searchRadius: {
    type:    Number,
    default: 5000,
    min:     500,
    max:     50000  // meters
  },

  // Set to true when the user completes onboarding for the first time.
  // Used by the OAuth callback to decide whether to send them to /app or /onboarding.
  onboardingComplete: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

// ─── Indexes ──────────────────────────────────────────────────────────────────
// Required for $near / $geoWithin queries — without this MongoDB does a full
// collection scan and $near throws an error on larger datasets.
userSchema.index({ location: '2dsphere' });

// Compound index for the nearby query filter: isVisible + lastSeen are both
// used in the find() — a compound index lets MongoDB satisfy both in one pass.
userSchema.index({ isVisible: 1, lastSeen: -1 });

// Speeds up deserializeUser (called on every authenticated request).
userSchema.index({ googleId: 1 });

module.exports = mongoose.model('User', userSchema);
