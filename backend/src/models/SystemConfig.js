const mongoose = require('mongoose');

// Generic versioned admin-settings store — not specific to the interview
// module, though the interview lifecycle is its first consumer. A write
// never edits a row in place; it inserts a new one with a later
// effectiveFrom. This is what makes a frozen historical calculation (e.g. a
// no-show penalty applied last month) keep reading against the value that
// was actually in effect on that date, even after an admin changes the
// setting today — see systemConfig.service.js#getEffective.
const systemConfigSchema = new mongoose.Schema({
    key: {
        type: String,
        required: [true, 'Config key is required'],
        trim: true
    },
    value: {
        type: mongoose.Schema.Types.Mixed,
        required: [true, 'Config value is required']
    },
    effectiveFrom: {
        type: Date,
        required: true,
        default: Date.now
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: false
});

// Most common query: "what was this key's effective value at date X" —
// sorted descending so a `$lte` filter on effectiveFrom, `.sort({effectiveFrom:-1}).findOne`,
// returns the newest applicable row in one index scan.
systemConfigSchema.index({ key: 1, effectiveFrom: -1 });

const SystemConfig = mongoose.model('SystemConfig', systemConfigSchema);

module.exports = SystemConfig;
