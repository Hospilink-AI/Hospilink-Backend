const mongoose = require('mongoose');

/**
 * Whether the details on a user's identity documents agree with each other
 * and with their profile (see identityCheck.service). Admin-only: kept apart
 * from the MedicalStaff and Hospital documents so no doctor- or
 * hospital-facing query can return it.
 */
const issueSchema = new mongoose.Schema({
    // NAME_MISMATCH | NAME_PARTIAL | DOB_MISMATCH | NUMBER_MISMATCH | DUPLICATE_PAN | COMPANY_NAME_MISMATCH
    code: { type: String, required: true },
    severity: { type: String, enum: ['high', 'low'], required: true },
    field: { type: String }, // 'name' | 'dob' | 'registrationNumber' | 'panNumber' | 'companyName'
    // What was compared: 'profile' or a document type
    source: { type: String },
    against: { type: String },
    sourceValue: { type: String },
    againstValue: { type: String },
    // DUPLICATE_PAN: the other account
    otherUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: false });

const comparisonSchema = new mongoose.Schema({
    field: String,
    source: String,
    against: String,
    result: { type: String, enum: ['match', 'partial', 'mismatch', 'unknown'] }
}, { _id: false });

const identityCheckSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    role: { type: String, enum: ['staff', 'hospital'], required: true },
    // clear: nothing differs | flagged: something differs | dismissed: an
    // admin reviewed these exact differences and accepted them
    status: { type: String, enum: ['clear', 'flagged', 'dismissed'], required: true },
    severity: { type: String, enum: ['high', 'low', null], default: null },
    issues: { type: [issueSchema], default: [] },
    // Every comparison made, including the ones that matched or couldn't be read
    comparisons: { type: [comparisonSchema], default: [] },
    // Identifies this exact set of issues: a dismissal covers it, and a
    // change starts a new flag
    fingerprint: { type: String, default: null },
    flaggedAt: { type: Date, default: null },
    checkedAt: { type: Date, required: true },
    dismissed: {
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: Date,
        note: String,
        fingerprint: String
    },
    // Reminders sent to the user for the current flag (high severity only)
    reminders: {
        count: { type: Number, default: 0 },
        lastSentAt: { type: Date, default: null }
    }
}, { timestamps: true });

// Admin queue (flagged accounts, newest first) and the reminder job
identityCheckSchema.index({ status: 1, severity: 1, flaggedAt: -1 });

module.exports = mongoose.model('IdentityCheck', identityCheckSchema);
