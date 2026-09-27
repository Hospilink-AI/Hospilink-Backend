const mongoose = require('mongoose');

// Deliberately separate from Review (spec §12) — a comment about the app
// itself must never be able to pull down a hospital's or a staff member's
// rating the way a duty review can.
const platformFeedbackSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['staff', 'hospital'], required: true },

    text: { type: String, required: true, maxlength: 1000, trim: true },

    area: {
        type: String,
        enum: ['onboarding', 'duty_flow', 'otp', 'notifications', 'payments', 'jobs', 'app_performance', 'other'],
        default: 'other'
    },

    // The bot's read on tone — displayed as such, one-click overridable by
    // an admin (spec §12), never treated as ground truth.
    sentiment: { type: String, enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'SEVERE_NEGATIVE'], default: 'NEUTRAL' },
    sentimentOverriddenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Distinct from sentiment — whether this describes something currently
    // blocking the user, not just how annoyed they sound (spec §12).
    urgencySignal: { type: Boolean, default: false },

    // Set when SEVERE_NEGATIVE + urgencySignal auto-converts this into a
    // platform.app_fault ticket.
    convertedToTicket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null }
}, {
    timestamps: true
});

platformFeedbackSchema.index({ user: 1, createdAt: -1 });
platformFeedbackSchema.index({ sentiment: 1, urgencySignal: 1, createdAt: -1 });

const PlatformFeedback = mongoose.model('PlatformFeedback', platformFeedbackSchema);

module.exports = PlatformFeedback;
