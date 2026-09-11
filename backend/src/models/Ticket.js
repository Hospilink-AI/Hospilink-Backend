const mongoose = require('mongoose');
const {
    DOMAINS, DOMAIN_CODES, CATEGORIES, RESOLUTION_CLASSES, SUBJECT_TYPES,
    PARTY_ROLES, SOURCES, PRIORITIES, QUEUES, STATUSES, ACTIVE_STATUSES,
    RESOLUTION_OUTCOMES, RESOLUTION_ACTIONS, EVIDENCE_PARTIES
} = require('../utils/ticket.constants');

const partySchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: PARTY_ROLES, required: true }
}, { _id: false });

const evidenceSchema = new mongoose.Schema({
    s3Key: { type: String, required: true },
    originalFileName: String,
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    // Who the file is visible to besides admins is derived from this at read
    // time — never the counterparty, per spec §08.03 — not stored as a flag.
    suppliedBy: { type: String, enum: EVIDENCE_PARTIES, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    uploadedAt: { type: Date, default: Date.now }
});

// Audit trail — every status change appends here, never rewritten. Same
// convention as Duty.statusHistory / JobApplication.statusHistory.
const statusHistorySchema = new mongoose.Schema({
    status: { type: String, enum: STATUSES, required: true },
    timestamp: { type: Date, default: Date.now, required: true },
    changedBy: { type: mongoose.Schema.Types.Mixed, required: true }, // ObjectId or 'system'
    reason: String
}, { _id: false });

const reassignmentSchema = new mongoose.Schema({
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true },
    at: { type: Date, default: Date.now }
}, { _id: false });

const resolutionActionSchema = new mongoose.Schema({
    action: { type: String, enum: RESOLUTION_ACTIONS, required: true },
    // e.g. { correctedEndTime } for CLOSE_DUTY_AT_STATED_TIME,
    // { ratingDelta } for APPLY_RATING_PENALTY, { otpType } for UNLOCK_OTP.
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    executedAt: { type: Date, default: Date.now }
}, { _id: false });

const ticketSchema = new mongoose.Schema({
    ticketId: { type: String, unique: true, required: true }, // HL-<DOM>-<YYMM>-<seq>, set in pre-validate

    domain: { type: String, enum: DOMAINS, required: true },              // derived from category's dot-prefix
    category: { type: String, enum: CATEGORIES, required: true },
    resolutionClass: { type: String, enum: RESOLUTION_CLASSES, required: true }, // derived — never set by a controller

    subjectType: { type: String, enum: SUBJECT_TYPES, required: true, default: 'NONE' },
    // INTERVIEW and PAYMENT subjectTypes both resolve into a JobApplication /
    // Duty document respectively — there's no separate Interview or Payment
    // collection. Resolution is a service concern, not a schema one.
    subjectId: {
        type: mongoose.Schema.Types.ObjectId,
        required: function () { return this.subjectType !== 'NONE'; },
        default: null
    },

    raisedBy: { type: partySchema, required: true },

    // Required for ADJUDICATED, forbidden otherwise — enforced on save, not
    // by convention (spec §04). Never exposed to the raiser's own view of
    // the ticket; only to admins deciding the case.
    raisedAgainst: {
        type: partySchema,
        default: undefined,
        validate: {
            validator: function (v) {
                const isAdjudicated = this.resolutionClass === 'ADJUDICATED';
                return isAdjudicated ? !!v : !v;
            },
            message: 'raisedAgainst is required for ADJUDICATED tickets and forbidden otherwise'
        }
    },

    source: { type: String, enum: SOURCES, required: true },
    botCategory: { type: String, enum: CATEGORIES, default: null },
    botConfidence: { type: Number, min: 0, max: 1, default: null },
    language: { type: String, enum: ['en', 'hi', 'mr'], default: 'en' },

    // Computed by ticket.service at creation (needs linkedContext already in
    // hand — e.g. whether the subject duty is live/imminent — so it belongs
    // in the service, not a cheap pure-lookup hook like domain/queue below).
    priority: { type: String, enum: PRIORITIES, required: true },
    priorityOverride: {
        value: { type: String, enum: PRIORITIES, default: null },
        reason: { type: String, default: null },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        at: { type: Date, default: null }
    },

    status: { type: String, enum: STATUSES, required: true, default: 'NEW' },
    statusHistory: [statusHistorySchema],

    // Also service-computed at creation (domain regime + creation time).
    slaAcknowledgeBy: { type: Date, required: true },
    // Priority-derived operational decide-by target (spec update). The old
    // domain-regime number this field used to hold now lives in
    // slaCeilingBy as the statutory backstop instead.
    slaDecideBy: { type: Date, required: true },
    // Priority-derived "first human reply" target — new clock from the spec
    // update.
    slaFirstReplyBy: { type: Date, required: true },
    // Interim proxy for "first human reply": set when the ticket is first
    // claimed, since real reply tracking needs live chat (not built yet).
    // To be replaced by an actual reply-event timestamp once chat ships.
    firstReplyAt: { type: Date, default: null },
    // The legal backstop that slaDecideBy used to be — old REGIME_SLA/
    // REGIME_BY_DOMAIN math, unchanged, now a ceiling rather than a target.
    slaCeilingBy: { type: Date, required: true },
    slaPausedMs: { type: Number, default: 0 },
    // Set when entering an AWAITING_* status, folded into slaPausedMs and
    // cleared on leaving it — lets a live countdown be shown without a cron
    // tick, while slaPausedMs itself stays accurate at rest between pauses.
    slaPauseStartedAt: { type: Date, default: null },

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    claimedAt: { type: Date, default: null }, // drives the 4h untouched-returns-to-queue rule (spec §07)
    queue: { type: String, enum: QUEUES, required: true }, // derived from category route; re-derived on recategorisation
    reassignmentHistory: [reassignmentSchema],

    evidence: { type: [evidenceSchema], default: [] },

    // Duty/application/payment/prior-ticket context resolved once at
    // creation (spec §04: "not typed by anyone"). Deliberately Mixed — its
    // shape varies by domain/subjectType, and nothing downstream queries
    // into it structurally, only displays it.
    linkedContext: { type: mongoose.Schema.Types.Mixed, default: {} },

    respondentNotifiedAt: { type: Date, default: null },
    respondentDeadline: { type: Date, default: null }, // 24h / 4h / 60min tier (spec update §08.02)
    respondentStatement: {
        text: { type: String, default: null },
        submittedAt: { type: Date, default: null },
        evidenceIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
        lapsed: { type: Boolean, default: false } // explicit non-answer, never treated as an admission
    },

    // Set when an admin uses requestInfo() to pause a ticket waiting on the
    // raiser (status becomes AWAITING_RAISER) — mirrors respondentNotifiedAt's
    // role for the other party's window.
    infoRequestedAt: { type: Date, default: null },

    // Reminder bookkeeping — one flag per distinct §13 notification trigger,
    // same nudgesSent-style pattern JobApplication already uses for its own
    // stall clocks, so the SLA cron never double-sends.
    reminders: {
        respondentHalfWindow: { type: Boolean, default: false },
        respondentTwoHoursLeft: { type: Boolean, default: false },
        raiserDay1: { type: Boolean, default: false },
        raiserDay3: { type: Boolean, default: false },
        slaAt75Percent: { type: Boolean, default: false }
    },

    resolutionOutcome: { type: String, enum: RESOLUTION_OUTCOMES, default: null },
    resolutionActions: { type: [resolutionActionSchema], default: [] },
    actionTakenStatement: { type: String, default: null }, // generated, never hand-typed (spec §08.05)

    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // set only when the action set required sign-off

    appealOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TicketConversation', default: null },

    // Only meaningful for the gated HOLD_PAYOUT/RELEASE_PAYOUT actions —
    // present now so the 7-day auto-release cron has somewhere to read from
    // once mediated payouts ship (spec §09: "specified and switched off").
    payoutFreeze: {
        amount: { type: Number, default: null },
        frozenAt: { type: Date, default: null },
        autoReleaseAt: { type: Date, default: null },
        releasedAt: { type: Date, default: null },
        releasedBy: { type: mongoose.Schema.Types.Mixed, default: null } // ObjectId or 'system'
    }
}, {
    timestamps: true
});

ticketSchema.index({ 'raisedBy.user': 1, createdAt: -1 });
ticketSchema.index({ queue: 1, status: 1, priority: 1, createdAt: -1 }); // agent queue list
ticketSchema.index({ assignedTo: 1, status: 1 });
ticketSchema.index({ domain: 1, category: 1 });
ticketSchema.index({ subjectType: 1, subjectId: 1 });
ticketSchema.index({ status: 1, slaDecideBy: 1 }); // SLA sweep cron
ticketSchema.index({ status: 1, claimedAt: 1 });    // claim-timeout sweep
ticketSchema.index({ appealOf: 1 });

// One open ticket per raiser+subject+category (spec §06.08 "Deduplication
// on creation"). DB-enforced via a partial unique index rather than a
// check-then-write in the service — the same pattern JobApplication.js uses
// for "one active application per candidate per vacancy": no race window.
ticketSchema.index(
    { 'raisedBy.user': 1, subjectId: 1, category: 1 },
    { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } } }
);

ticketSchema.statics.generateNextId = async function (domainCode) {
    const TicketCounter = require('./TicketCounter');
    const now = new Date();
    const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const key = `${domainCode}-${yymm}`;
    const counter = await TicketCounter.findOneAndUpdate(
        { key }, { $inc: { seq: 1 } }, { upsert: true, new: true }
    );
    return `HL-${key}-${String(counter.seq).padStart(5, '0')}`;
};

ticketSchema.methods.pushHistory = function (status, changedBy, reason) {
    this.statusHistory.push({ status, timestamp: new Date(), changedBy, reason });
};

// domain/ticketId are pure functions of category, fit for a hook. queue and
// resolutionClass also derive from category, but route through the
// DB-backed ticketCategoryConfig.service (spec §07/15's "editable without a
// deploy"), so they need an async lookup here rather than a static in-file
// map.
ticketSchema.pre('validate', async function (next) {
    try {
        if (this.isNew) {
            this.domain = this.category.split('.')[0];
            if (!this.ticketId) {
                this.ticketId = await this.constructor.generateNextId(DOMAIN_CODES[this.domain]);
            }
        }

        if (this.isNew || this.isModified('category')) {
            const ticketCategoryConfigService = require('../services/ticketCategoryConfig.service');
            const config = await ticketCategoryConfigService.getByCategory(this.category);
            this.resolutionClass = config.resolutionClass;
            this.queue = config.queue;
        }

        next();
    } catch (err) {
        next(err);
    }
});

const Ticket = mongoose.model('Ticket', ticketSchema);

module.exports = Ticket;
