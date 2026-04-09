const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    recipient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'Recipient is required'],
        index: true
    },
    type: {
        type: String,
        enum: ['DUTY_CREATED', 'DUTY_ACCEPTED', 'DUTY_STATUS_CHANGED', 'DUTY_CANCELLED', 'DUTY_EDITED', 'REVIEW_RECEIVED', 'EMERGENCY_DUTY_REQUEST'],
        required: [true, 'Notification type is required']
    },
    priority: {
        type: String,
        enum: ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'],
        default: 'NORMAL'
    },
    payload: {
        type: mongoose.Schema.Types.Mixed,
        required: [true, 'Notification payload is required']
    },
    isRead: {
        type: Boolean,
        default: false,
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: false // We're managing createdAt manually
});

// Compound indexes for efficient queries
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1 });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
