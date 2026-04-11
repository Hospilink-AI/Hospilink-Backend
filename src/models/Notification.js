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
        enum: ['DUTY_CREATED', 'NEW_DUTY_OFFER', 'DUTY_CONFIRMED', 'STAFF_ASSIGNED', 'NAVIGATE_TO_DUTY', 'STAFF_EN_ROUTE', 
            'STAFF_ON_SITE', 'DUTY_STATUS_CHANGED', 'DUTY_CANCELLED_BY_HOSPITAL', 'DUTY_CANCELLED_BY_STAFF', 
            'DUTY_EDITED', 'DUTY_COMPLETED', 'REVIEW_RECEIVED'],
        required: [true, 'Notification type is required']
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
