const mongoose = require('mongoose');

const TIME = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

// When a doctor says they are free to work. A weekly pattern plus dated
// exceptions; an exception always beats the pattern. The pattern stops
// counting after validUntil so stale calendars don't mislead matching.
// Read through utils/availability.helper.js.
const staffAvailabilitySchema = new mongoose.Schema({
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicalStaff', required: true, unique: true },

    weekly: [{
        _id: false,
        day: { type: Number, min: 0, max: 6, required: true }, // 0 = Sunday
        from: { type: String, match: TIME },
        to: { type: String, match: TIME }
    }],
    validUntil: { type: Date },

    exceptions: [{
        _id: false,
        date: { type: String, required: true }, // IST 'YYYY-MM-DD'
        status: { type: String, enum: ['free', 'busy'], required: true },
        from: { type: String, match: TIME },
        to: { type: String, match: TIME }
    }],

    reminderSentAt: { type: Date }
}, { timestamps: true });

staffAvailabilitySchema.index({ validUntil: 1 });

module.exports = mongoose.model('StaffAvailability', staffAvailabilitySchema);
