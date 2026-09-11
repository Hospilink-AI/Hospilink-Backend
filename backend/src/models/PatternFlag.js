const mongoose = require('mongoose');

// One model covers both plain repeat-behaviour flags and suspension
// proposals (spec §10) — a proposal is just a flag that crossed a higher
// threshold, same party, same cases relied on. `proposal` stays undefined
// until `raises` is 'suspension_proposal'; the system never suspends
// anyone off this record alone — a human always decides via
// proposal.decision.
const partyResponseSchema = new mongoose.Schema({
    text: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    lapsed: { type: Boolean, default: false }
}, { _id: false });

const patternFlagSchema = new mongoose.Schema({
    party: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    partyRole: { type: String, enum: ['staff', 'hospital'], required: true },

    // e.g. 'staff_no_show', 'hospital_conduct', 'interview_no_show' — the
    // spec §10 pattern-table row this flag corresponds to.
    patternType: { type: String, required: true },

    windowDays: { type: Number, required: true },
    thresholdCount: { type: Number, required: true },
    actualCount: { type: Number, required: true },

    // The upheld tickets that pushed this flag over its threshold —
    // always visible to the flagged party (spec §10.04: "never a shadow record").
    casesRelied: { type: [mongoose.Schema.Types.ObjectId], ref: 'Ticket', default: [] },

    raises: {
        type: String,
        enum: ['operations_flag', 'suspension_proposal', 'precautionary_restriction'],
        required: true
    },
    status: { type: String, enum: ['open', 'responded', 'decided', 'voided'], default: 'open' },

    // Populated only when raises === 'suspension_proposal'. 14-day
    // statutory response window (spec §10.02) before a human — never the
    // threshold itself — decides.
    proposal: {
        responseDeadline: { type: Date, default: null },
        partyResponse: { type: partyResponseSchema, default: null },
        decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        decision: { type: String, enum: ['suspend', 'no_action'], default: null },
        decisionReason: { type: String, default: null },
        decidedAt: { type: Date, default: null }
    }
}, {
    timestamps: true
});

patternFlagSchema.index({ party: 1, status: 1 });
patternFlagSchema.index({ raises: 1, status: 1 });

const PatternFlag = mongoose.model('PatternFlag', patternFlagSchema);

module.exports = PatternFlag;
