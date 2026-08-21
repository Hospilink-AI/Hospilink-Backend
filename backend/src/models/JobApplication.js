const mongoose = require('mongoose');
const {
    STATUSES, TERMINAL_STATUSES, ACTIVE_STATUSES, GENERIC_TRANSITIONS,
    REJECTION_REASONS, RECRUITER_CHANGE_REASONS, CANDIDATE_CHANGE_REASONS,
    WITHDRAW_REASONS, SLOT_DURATIONS, REASON_TEXT_MAX_LENGTH
} = require('../utils/jobApplication.constants');

// One document per candidate-vacancy pair. The interview handshake is
// embedded rather than a separate collection — it's a strict 1:1 with the
// application (one interview round per application), so embedding avoids a
// join on every read and mirrors how Duty embeds startOtp/endOtp.
const slotSchema = new mongoose.Schema({
    start: { type: Date, required: true },
    end: { type: Date, required: true }
}, { _id: false });

const jobApplicationSchema = new mongoose.Schema({
    vacancy: { type: mongoose.Schema.Types.ObjectId, ref: 'JobVacancy', required: true },
    // Denormalized from vacancy.hospitalId — every hospital-scoped query
    // (listForVacancy, ownership checks) filters on this directly instead of
    // populating the vacancy first.
    hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicalStaff', required: true },
    // Denormalized from staff.user — notification targeting reads this
    // directly without a second MedicalStaff lookup.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Snapshot of which Document.documents[] entry was the active resume at
    // apply time — not a live pointer. If the candidate replaces their resume
    // later, this application keeps referencing the one the hospital was
    // actually shown.
    resumeDocumentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    resumeS3Key: { type: String, required: true },

    // Frozen at apply time via vacancyMatchingService.computeMatchScore() —
    // never recomputed for this application afterward (candidate-side "frozen
    // snapshot" requirement).
    matchScoreSnapshot: {
        score: { type: Number, default: null },
        breakdown: { type: mongoose.Schema.Types.Mixed, default: null },
        gateTier: { type: String, enum: ['exact', 'related', 'unscored'], default: 'unscored' }
    },

    status: {
        type: String,
        enum: STATUSES,
        default: 'applied',
        required: true
    },

    // Audit trail — every status change appends here, never rewritten.
    statusHistory: [{
        status: { type: String, enum: STATUSES, required: true },
        timestamp: { type: Date, default: Date.now, required: true },
        // ObjectId of whoever made the change, or the literal string 'system'
        // for cron-driven transitions (expiry, both-absent lapse).
        changedBy: { type: mongoose.Schema.Types.Mixed, required: true },
        reason: String,
        // Set on cancel-interview/reschedule actions taken inside the
        // late-change threshold (§06). Tracked, never itself penalized —
        // "no penalty is applied to a late change, only to a no-show." A
        // dedicated ops aggregation/dashboard over this flag is a
        // reporting-layer follow-up, not required for the state machine.
        isLateChange: { type: Boolean, default: false }
    }],

    appliedAt: { type: Date, default: Date.now },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },

    rejectionReason: { type: String, enum: REJECTION_REASONS, default: null },
    rejectionReasonText: { type: String, maxlength: REASON_TEXT_MAX_LENGTH, default: null },

    withdrawnAt: { type: Date, default: null },
    withdrawReason: { type: String, enum: WITHDRAW_REASONS, default: null },
    withdrawReasonText: { type: String, maxlength: REASON_TEXT_MAX_LENGTH, default: null },

    interview: {
        offer: {
            slots: { type: [slotSchema], default: undefined },
            durationMinutes: { type: Number, enum: SLOT_DURATIONS, default: undefined },
            offeredAt: { type: Date, default: null },
            offeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
            // = min(offeredAt + offerExpiryDays, last slot's start) — computed
            // once at write time in interviewScheduling.service.js#offerSlots,
            // never recalculated on read. This is what makes the "collapsed
            // window" behaviour (an offer for next week doesn't live 21 days)
            // correct without a live computation on every read.
            expiresAt: { type: Date, default: null },
            cancelledAt: { type: Date, default: null },
            cancelReason: { type: String, enum: RECRUITER_CHANGE_REASONS, default: null },
            cancelReasonText: { type: String, maxlength: REASON_TEXT_MAX_LENGTH, default: null },
            nudgesSent: {
                day3: { type: Boolean, default: false },
                day10: { type: Boolean, default: false },
                day18: { type: Boolean, default: false }
            }
        },

        candidatePicks: { type: [slotSchema], default: undefined },
        pickedAt: { type: Date, default: null },
        // Selection-expiry nudges (day 3/10/18 counted from pickedAt, against
        // the recruiter) — separate flag set from the offer's, since the two
        // stall clocks run independently.
        selectionNudgesSent: {
            day3: { type: Boolean, default: false },
            day10: { type: Boolean, default: false },
            day18: { type: Boolean, default: false }
        },

        // Only ever set via the conditional write in
        // interviewScheduling.service.js#confirmInterview — see the partial
        // unique index below for how contention is actually enforced.
        //
        // Deliberately NO `default: null` on start/end: Mongoose materializes
        // a defaulted path on every document at creation time, which would
        // make `interview.confirmedSlot.start` exist (as null) on every
        // application from the moment it's created — the partial index's
        // `$exists: true` filter would then match ALL applications on a
        // vacancy instead of only confirmed ones, and MongoDB's unique index
        // treats multiple `null` values as colliding, so a second application
        // for the same vacancy would fail to insert at all. Leaving no
        // default means the path is genuinely absent until confirmInterview
        // sets it, and genuinely absent again after a reschedule unsets it.
        confirmedSlot: {
            start: { type: Date },
            end: { type: Date }
        },
        confirmedAt: { type: Date, default: null },
        confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

        meetingLink: { type: String, default: null },
        interviewerName: { type: String, default: null },
        interviewerDesignation: { type: String, default: null },
        linkHistory: [{
            link: String,
            changedAt: { type: Date, default: Date.now },
            changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
        }],

        reminders: {
            sent24h: { type: Boolean, default: false },
            sent1h: { type: Boolean, default: false }
        },

        rescheduleCount: { type: Number, default: 0 },
        rescheduleHistory: [{
            by: { type: String, enum: ['staff', 'hospital'] },
            reason: String,
            reasonText: { type: String, maxlength: REASON_TEXT_MAX_LENGTH },
            at: { type: Date, default: Date.now },
            previousSlot: { start: Date, end: Date }
        }],
        // Candidate-initiated — flags the confirmed booking for recruiter
        // attention without changing status. See §04.8: "the existing booking
        // stands until the recruiter acts."
        rescheduleRequest: {
            requestedAt: { type: Date, default: null },
            reason: { type: String, enum: CANDIDATE_CHANGE_REASONS, default: null },
            reasonText: { type: String, maxlength: REASON_TEXT_MAX_LENGTH, default: null },
            pending: { type: Boolean, default: false }
        },

        outcome: {
            result: { type: String, enum: ['offer', 'reject', 'no_show', 'not_recorded'], default: null },
            recordedAt: { type: Date, default: null },
            // ObjectId of the recruiter, or 'system' for the both-absent cron lapse.
            recordedBy: { type: mongoose.Schema.Types.Mixed, default: null }
        },

        noShow: {
            by: { type: String, enum: ['candidate', 'hospital'], default: null },
            markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
            markedAt: { type: Date, default: null },
            disputeStatus: { type: String, enum: ['none', 'open', 'upheld', 'voided'], default: 'none' },
            disputeReason: { type: String, default: null },
            disputedAt: { type: Date, default: null },
            resolvedAt: { type: Date, default: null },
            resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
        }
    },

    // Tier 3 release event — written once, at hired. "The candidate is
    // notified that their contact details have been shared with the named
    // hospital, and the release is logged with a timestamp against the
    // consent record."
    contactRelease: {
        releasedAt: { type: Date, default: null },
        releasedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', default: null }
    },

    // Hire close-out nudge bookkeeping, tracked per sibling application so
    // each one gets its own independent weekly cadence.
    closeoutNudge: {
        lastSentAt: { type: Date, default: null }
    }
}, {
    timestamps: true
});

// At most one ACTIVE application per candidate per vacancy. MongoDB enforces
// this at the storage layer via a partial index — a withdrawn/rejected/hired
// row is excluded from the filter, so a fresh `applied` row after any of
// those always succeeds without extra application-level checking.
jobApplicationSchema.index(
    { vacancy: 1, staff: 1 },
    { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } } }
);

// THE slot-contention mechanism. No two applications on the same vacancy can
// hold the same confirmed start time — enforced by MongoDB itself, so
// confirmInterview() never needs a manual pre-check-then-write (which would
// have a race window) or a multi-document transaction. See
// interviewScheduling.service.js#confirmInterview.
jobApplicationSchema.index(
    { vacancy: 1, 'interview.confirmedSlot.start': 1 },
    { unique: true, partialFilterExpression: { 'interview.confirmedSlot.start': { $exists: true } } }
);

jobApplicationSchema.index({ hospitalId: 1, vacancy: 1, status: 1 });
jobApplicationSchema.index({ staff: 1, createdAt: -1 });
jobApplicationSchema.index({ user: 1 });
// Lifecycle-cron sweeps (§06): offer/selection expiry and reminders all
// filter on status + a date field together.
jobApplicationSchema.index({ status: 1, 'interview.offer.expiresAt': 1 });
jobApplicationSchema.index({ status: 1, 'interview.confirmedSlot.start': 1 });

// Generic PATCH /applications/:id/status transitions only (§03). offer-slots,
// select, confirm, reschedule, cancel, outcome and no-show are each their own
// dedicated service method with their own preconditions — deliberately not
// reachable through this generic check, the same split Duty.js uses between
// staff-driven canChangeStatus and OTP/cron-driven transitions.
jobApplicationSchema.methods.canTransitionGeneric = function (newStatus) {
    const allowed = (GENERIC_TRANSITIONS[this.status] || []).includes(newStatus);
    return allowed
        ? { allowed: true }
        : { allowed: false, reason: `Cannot change from ${this.status} to ${newStatus}` };
};

// Withdraw is candidate-only, valid from any status that isn't already terminal.
jobApplicationSchema.methods.canWithdraw = function () {
    return TERMINAL_STATUSES.includes(this.status)
        ? { allowed: false, reason: `Cannot withdraw an application that is already ${this.status}` }
        : { allowed: true };
};

jobApplicationSchema.methods.pushHistory = function (status, changedBy, reason, isLateChange = false) {
    this.statusHistory.push({ status, timestamp: new Date(), changedBy, reason, isLateChange });
};

const JobApplication = mongoose.model('JobApplication', jobApplicationSchema);

module.exports = JobApplication;
