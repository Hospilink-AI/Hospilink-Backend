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
        enum: ['DUTY_CREATED', 'EMERGENCY_REQUEST_ACKNOWLEDGED', 'NEW_DUTY_OFFER', 'EMERGENCY_DUTY_REQUEST', 'DUTY_CONFIRMED', 'STAFF_ASSIGNED', 'NAVIGATE_TO_DUTY', 'STAFF_EN_ROUTE',
            'STAFF_ON_SITE', 'DUTY_IN_PROGRESS', 'DUTY_CANCELLED_BY_HOSPITAL', 'DUTY_CANCELLED_BY_STAFF',
            'DUTY_EDITED', 'DUTY_COMPLETED', 'REVIEW_RECEIVED', 'DOCUMENT_VERIFIED', 'DOCUMENT_REJECTED',
            'NEW_HOSPITAL_REGISTRATION', 'NEW_STAFF_REGISTRATION',
            'DUTY_UNASSIGNED_15MIN', 'DUTY_UNFILLED_CRITICAL', 'EMERGENCY_ADMIN_ALERT',
            'HOSPITAL_VERIFIED', 'HOSPITAL_VERIFIED_ADMIN', 'HOSPITAL_REJECTED', 'HOSPITAL_REJECTED_ADMIN',
            'STAFF_VERIFIED', 'STAFF_VERIFIED_ADMIN', 'STAFF_REJECTED', 'STAFF_REJECTED_ADMIN',
            'PASSWORD_CHANGED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_ACTIVATED'],
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
    deliveredAt: {
        type: Date,
        default: null,
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
notificationSchema.index({ recipient: 1, deliveredAt: 1 }); // For undelivered queries

// TTL index - automatically delete notifications older than 90 days
// This prevents the notifications collection from growing indefinitely
notificationSchema.index(
    { createdAt: 1 },
    {
        expireAfterSeconds: 90 * 24 * 60 * 60, // 90 days in seconds
        name: 'notification_ttl_index'
    }
);

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
