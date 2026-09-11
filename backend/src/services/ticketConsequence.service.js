const adminService = require('./admin.service');
const systemConfigService = require('./systemConfig.service');
const { UnprocessableEntityError } = require('../middleware/error.middleware');
const { RESOLUTION_ACTIONS_GATED } = require('../utils/ticket.constants');

// Two-person sign-off is required whenever any proposed action touches
// money, a rating, or account status (spec §07.03/§08.04). Classification
// covers every live action, including the 10 not implemented yet — nothing
// needs reclassifying once they land, only a HANDLERS entry.
const ACTIONS_REQUIRING_APPROVAL = new Set([
    'REVERSE_RATING_PENALTY', 'APPLY_RATING_PENALTY', 'SUPPRESS_REVIEW',
    'REINSTATE_APPLICATION', 'REVOKE_APPLICATION', 'ISSUE_WARNING',
    'FLAG_FOR_SUSPENSION', 'APPLY_PRECAUTIONARY_RESTRICTION', 'RESTORE_ACCOUNT',
    ...RESOLUTION_ACTIONS_GATED
]);

function assertDutySubject(ticket) {
    if (ticket.subjectType !== 'DUTY' || !ticket.subjectId) {
        throw new UnprocessableEntityError('This action requires a duty as the ticket subject.');
    }
}

// Each handler returns a patch merged into the resolutionActions[] entry's
// `details` — never mutates the ticket document itself (the caller,
// ticket.service#execute-time methods, own status/executedAt bookkeeping).
const HANDLERS = {
    RECORD_ONLY: async () => ({}),

    // Delegates entirely to the existing admin duty-override — same
    // transition map (including pending-confirmation → completed) already
    // live behind PATCH /api/admin/duties/:id/admin-override.
    SET_DUTY_STATUS: async (ticket, entry, adminId, reason) => {
        assertDutySubject(ticket);
        if (!entry.details?.newStatus) {
            throw new UnprocessableEntityError('SET_DUTY_STATUS requires details.newStatus');
        }
        await adminService.adminOverrideDutyStatus(ticket.subjectId, adminId, entry.details.newStatus, reason);
        return {};
    },

    // The spec's own flagship example (duty.end_otp_unverified): moves a
    // pending-confirmation duty to completed, optionally with a corrected
    // end time the admin-override call itself doesn't take a parameter for.
    CLOSE_DUTY_AT_STATED_TIME: async (ticket, entry, adminId, reason) => {
        assertDutySubject(ticket);
        const duty = await adminService.adminOverrideDutyStatus(ticket.subjectId, adminId, 'completed', reason);
        if (entry.details?.correctedEndTime) {
            duty.completedAt = new Date(entry.details.correctedEndTime);
            await duty.save();
        }
        return {};
    },

    UNLOCK_OTP: async (ticket, entry, adminId, reason) => {
        assertDutySubject(ticket);
        if (!entry.details?.otpType) {
            throw new UnprocessableEntityError('UNLOCK_OTP requires details.otpType (start|end)');
        }
        await adminService.unlockDutyOtp(ticket.subjectId, entry.details.otpType, adminId, reason);
        return {};
    },

    // Deliberately doesn't touch MedicalStaff/Hospital.averageRating —
    // review.service.js computes that as a running weighted mean from real
    // Review documents; a direct adjustment here would corrupt that math
    // with no clean way to un-apply it later. Recording the penalty *is*
    // the execution, same pattern noShowPenalty.service.js already uses:
    // nothing is stamped, a live reader counts qualifying tickets in a
    // trailing window later (that reader is a follow-up, not required for
    // this action to be correctly "done").
    APPLY_RATING_PENALTY: async (ticket, entry) => {
        if (typeof entry.details?.ratingDelta !== 'number') {
            throw new UnprocessableEntityError('APPLY_RATING_PENALTY requires details.ratingDelta');
        }
        return { appliedAt: new Date() };
    },

    REVERSE_RATING_PENALTY: async (ticket, entry) => {
        return { reversedAt: new Date() };
    },

    // All three below need a real counterparty — the ticket must be
    // ADJUDICATED with a raisedAgainst party, since that's who the action
    // targets. Each just creates a PatternFlag; patternEngine.service.js's
    // automatic threshold detector and these admin-triggered flags share
    // the same underlying record and review/response flow.
    FLAG_FOR_SUSPENSION: async (ticket, entry, adminId) => {
        if (!ticket.raisedAgainst) {
            throw new UnprocessableEntityError('FLAG_FOR_SUSPENSION requires a ticket with a respondent.');
        }
        const patternEngineService = require('./patternEngine.service');
        const flag = await patternEngineService.createManualFlag({
            party: ticket.raisedAgainst.user, partyRole: ticket.raisedAgainst.role,
            raises: 'suspension_proposal', reason: entry.details?.reason, ticketId: ticket._id
        });
        return { flagId: flag._id };
    },

    APPLY_PRECAUTIONARY_RESTRICTION: async (ticket, entry) => {
        if (!ticket.raisedAgainst) {
            throw new UnprocessableEntityError('APPLY_PRECAUTIONARY_RESTRICTION requires a ticket with a respondent.');
        }
        const patternEngineService = require('./patternEngine.service');
        const flag = await patternEngineService.createManualFlag({
            party: ticket.raisedAgainst.user, partyRole: ticket.raisedAgainst.role,
            raises: 'precautionary_restriction', reason: entry.details?.reason, ticketId: ticket._id
        });
        // Flag created and visible immediately, per spec §10.03 ("pause at
        // once"). Actually blocking new duty offers is a follow-up — no
        // enforcement hook exists in the duty-assignment path yet.
        return { flagId: flag._id, enforced: false };
    },

    ISSUE_WARNING: async (ticket, entry) => {
        if (!ticket.raisedAgainst) {
            throw new UnprocessableEntityError('ISSUE_WARNING requires a ticket with a respondent.');
        }
        const patternEngineService = require('./patternEngine.service');
        const flag = await patternEngineService.createManualFlag({
            party: ticket.raisedAgainst.user, partyRole: ticket.raisedAgainst.role,
            raises: 'operations_flag', reason: entry.details?.reason, ticketId: ticket._id
        });
        return { flagId: flag._id };
    },

    RESTORE_ACCOUNT: async (ticket, entry, adminId) => {
        if (!entry.details?.flagId) {
            throw new UnprocessableEntityError('RESTORE_ACCOUNT requires details.flagId');
        }
        const patternEngineService = require('./patternEngine.service');
        await patternEngineService.voidFlag(entry.details.flagId, adminId);
        return { restoredAt: new Date() };
    }
};

function isImplemented(action) {
    return Object.prototype.hasOwnProperty.call(HANDLERS, action);
}

function isGated(action) {
    return RESOLUTION_ACTIONS_GATED.includes(action);
}

function requiresApproval(resolutionActions) {
    return resolutionActions.some(a => ACTIONS_REQUIRING_APPROVAL.has(a.action));
}

// Runs every proposed action, in order. Assumes isImplemented() was already
// checked at proposal time (ticket.service#decide) — a failure here means
// something changed between proposal and execution (e.g. the duty itself
// moved to a state the override map no longer allows), which should
// surface as a real error, not be swallowed.
async function execute(ticket, adminId, reason) {
    for (const entry of ticket.resolutionActions) {
        const handler = HANDLERS[entry.action];
        if (!handler) {
            throw new UnprocessableEntityError(`${entry.action} is not implemented yet.`);
        }
        const patch = await handler(ticket, entry, adminId, reason);
        entry.details = { ...(entry.details || {}), ...patch };
        entry.executedAt = new Date();
    }
}

function humanizeCategory(category) {
    return category.replace('.', ' — ').replace(/_/g, ' ');
}

function humanizeAction(action) {
    return action.toLowerCase().replace(/_/g, ' ');
}

// "Generated, not written" (spec §08.05) — assembled from structured
// fields; the agent only ever supplies `note`.
function generateStatement({ category, resolutionOutcome, resolutionActions, note, appealWindowDays }) {
    const lines = [
        `Category: ${humanizeCategory(category)}`,
        `Finding: ${resolutionOutcome}`,
        resolutionActions.length
            ? `Action taken: ${resolutionActions.map(a => humanizeAction(a.action)).join(', ')}`
            : 'Action taken: none'
    ];
    if (note) lines.push(`Note: ${note}`);
    lines.push(`You may appeal this decision within ${appealWindowDays} days.`);
    return lines.join('\n\n');
}

async function buildStatement(ticket, note) {
    const appealWindowDays = await systemConfigService.getEffective('ticket.appealWindowDays');
    return generateStatement({
        category: ticket.category,
        resolutionOutcome: ticket.resolutionOutcome,
        resolutionActions: ticket.resolutionActions,
        note,
        appealWindowDays
    });
}

module.exports = {
    ACTIONS_REQUIRING_APPROVAL,
    isImplemented,
    isGated,
    requiresApproval,
    execute,
    generateStatement,
    buildStatement
};
