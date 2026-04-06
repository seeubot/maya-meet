const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  avatar: { type: String, default: '' },

  // Profile
  bio: { type: String, default: '', maxlength: 200 },
  interests: [{ type: String, trim: true }],
  lookingFor: {
    type: String,
    enum: ['friendship', 'networking', 'dating', 'collaboration', 'all'],
    default: 'all'
  },

  // Location
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
    city: { type: String, default: '' },
    country: { type: String, default: '' }
  },

  // Visibility
  isVisible: { type: Boolean, default: true },
  lastSeen: { type: Date, default: Date.now },
  isOnline: { type: Boolean, default: false },

  // Settings
  searchRadius: { type: Number, default: 5000, min: 500, max: 50000 }, // meters

  createdAt: { type: Date, default: Date.now }
});

userSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('User', userSchema);
