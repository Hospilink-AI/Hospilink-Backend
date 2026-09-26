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
        enum: ['DUTY_CREATED', 'EMERGENCY_REQUEST_ACKNOWLEDGED', 'NEW_DUTY_OFFER', 'EMERGENCY_DUTY_REQUEST','DUTY_CONFIRMED', 'STAFF_ASSIGNED', 'NAVIGATE_TO_DUTY', 'STAFF_EN_ROUTE', 
            'STAFF_ON_SITE', 'DUTY_IN_PROGRESS', 'DUTY_CANCELLED_BY_HOSPITAL', 'DUTY_CANCELLED_BY_STAFF', 
            'DUTY_EDITED', 'DUTY_COMPLETED', 'REVIEW_RECEIVED', 'DOCUMENT_VERIFIED', 'DOCUMENT_REJECTED', 
            'NEW_HOSPITAL_REGISTRATION', 'NEW_STAFF_REGISTRATION',
            'DUTY_UNASSIGNED_15MIN', 'DUTY_UNFILLED_CRITICAL', 'EMERGENCY_ADMIN_ALERT',
            'HOSPITAL_VERIFIED', 'HOSPITAL_VERIFIED_ADMIN', 'HOSPITAL_REJECTED', 'HOSPITAL_REJECTED_ADMIN',
            'STAFF_VERIFIED', 'STAFF_VERIFIED_ADMIN', 'STAFF_REJECTED', 'STAFF_REJECTED_ADMIN',
            'PASSWORD_CHANGED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_ACTIVATED', 'RATE_HOSPITAL_PROMPT',
            'PROFILE_AUTO_FILLED_FROM_RESUME', 'RESUME_ANALYZED',
            // Job application — apply/review pipeline
            'PROFILE_REQUIRED_FOR_APPLICATION', 'RESUME_REQUIRED_FOR_APPLICATION',
            'NEW_JOB_APPLICATION', 'APPLICATION_SHORTLISTED', 'APPLICATION_REJECTED',
            'APPLICATION_WITHDRAWN', 'APPLICATION_HIRED',
            // Job application — interview scheduling
            'SLOTS_OFFERED', 'OFFER_UNANSWERED_REMINDER', 'OFFER_EXPIRED',
            'CANDIDATE_PICKED_SLOTS', 'CONFIRMATION_PENDING_REMINDER', 'SELECTION_EXPIRED',
            'INTERVIEW_CONFIRMED', 'INTERVIEW_REMINDER_24H', 'INTERVIEW_REMINDER_1H',
            'MEETING_LINK_CHANGED', 'INTERVIEW_CANCELLED', 'INTERVIEW_RESCHEDULED',
            'RESCHEDULE_REQUESTED',
            // Job application — outcome, no-show, offer, close-out
            'MARKED_NO_SHOW', 'HOSPITAL_NO_SHOW_REPORTED', 'JOB_OFFER_EXTENDED',
            'CONTACT_DETAILS_RELEASED', 'HIRE_CLOSEOUT_PROMPT',
            // Disputes & Support — ticket lifecycle
            'TICKET_CREATED', 'TICKET_RECATEGORIZED',
            'TICKET_CLAIM_EXISTS', 'TICKET_RESPONSE_WINDOW_CLOSING', 'TICKET_OUTCOME_DECIDED',
            'TICKET_APPEAL_OUTCOME', 'TICKET_INFO_REQUESTED', 'TICKET_INFO_REQUEST_REMINDER',
            'TICKET_CHAT_MESSAGE',
            'PATTERN_FLAG_RAISED', 'SUSPENSION_PROPOSED', 'SUSPENSION_DECIDED'],
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
