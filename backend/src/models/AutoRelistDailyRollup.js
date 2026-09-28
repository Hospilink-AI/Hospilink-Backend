const mongoose = require('mongoose');

// "Aggregates are computed on a nightly rollup, not on the fly" —
// one document per platform-wide day, one per hospital-per-day. `date` is
// always truncated to local midnight (the day the relist events happened
// on), never a timestamp. Written by autoRelistAnalytics.service.js's
// computeDailyRollup, scheduled once a day in utils/cronJobs.js; the
// current day is always computed live instead of read from here (spec's
// own instruction — "read the current day live").
const autoRelistDailyRollupSchema = new mongoose.Schema({
    scope: { type: String, enum: ['platform', 'hospital'], required: true },
    hospital: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null },
    date: { type: Date, required: true },

    relistsCount: { type: Number, default: 0 },
    refilledCount: { type: Number, default: 0 },
    boostedCount: { type: Number, default: 0 },
    boostedFilledCount: { type: Number, default: 0 },
    unboostedCount: { type: Number, default: 0 },
    unboostedFilledCount: { type: Number, default: 0 },
    extraPaid: { type: Number, default: 0 },

    // Cancellation reason -> count for that day, e.g. { emergency: 2, illness: 1 }
    byReason: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

autoRelistDailyRollupSchema.index({ scope: 1, hospital: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('AutoRelistDailyRollup', autoRelistDailyRollupSchema);
