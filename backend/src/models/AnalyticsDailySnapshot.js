const mongoose = require('mongoose');

// One row per IST day for the admin analytics module. Holds what can't be
// worked out again later: point-in-time counts (stocks) taken when the row
// is written, and a durable copy of the day's headline numbers (flows) whose
// sources expire (notifications keep 90 days).
const analyticsDailySnapshotSchema = new mongoose.Schema({
    // IST day, 'YYYY-MM-DD'
    date: { type: String, required: true },
    scope: { type: String, enum: ['platform'], default: 'platform' },
    scopeKey: { type: String, default: 'all' },
    metricsVersion: { type: Number, default: 1 },

    stocks: { type: mongoose.Schema.Types.Mixed, default: {} },
    flows: { type: mongoose.Schema.Types.Mixed, default: {} },

    computedAt: { type: Date, default: Date.now }
}, { timestamps: true });

analyticsDailySnapshotSchema.index({ date: 1, scope: 1, scopeKey: 1 }, { unique: true });

module.exports = mongoose.model('AnalyticsDailySnapshot', analyticsDailySnapshotSchema);
