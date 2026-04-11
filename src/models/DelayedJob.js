const mongoose = require('mongoose');

const delayedJobSchema = new mongoose.Schema({
    type: {
        type: String,
        required: true,
        index: true
    },
    executeAt: {
        type: Date,
        required: true,
        index: true
    },
    payload: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed'],
        default: 'pending',
        index: true
    },
    processed: {
        type: Boolean,
        default: false,
        index: true
    },
    attempts: {
        type: Number,
        default: 0
    },
    lastError: String
}, {
    timestamps: true
});

delayedJobSchema.index({ executeAt: 1, status: 1 });

module.exports = mongoose.model('DelayedJob', delayedJobSchema);