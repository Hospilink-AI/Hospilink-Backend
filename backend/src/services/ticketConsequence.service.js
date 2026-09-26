const adminService = require('./admin.service');
const systemConfigService = require('./systemConfig.service');
const cacheService = require('./cache.service');
const jobApplicationService = require('./jobApplication.service');
const vacancyMatchingService = require('./vacancyMatching.service');
const noShowPenaltyService = require('./noShowPenalty.service');
const ratingAlgorithmService = require('./ratingAlgorithm.service');
const notificationEmitter = require('./notificationEmitter');
const JobApplication = require('../models/JobApplication');
const JobVacancy = require('../models/JobVacancy');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const Review = require('../models/Review');
const Ticket = require('../models/Ticket');
const { UnprocessableEntityError } = require('../middleware/error.middleware');
const { RESOLUTION_ACTIONS_GATED } = require('../utils/ticket.constants');
const { RATING_PENALTY_POINTS_BY_CATEGORY } = require('../utils/rating.constants');
const { TERMINAL_STATUSES, REASON_TEXT_MAX_LENGTH } = require('../utils/jobApplication.constants');

// profile.user is sometimes a raw ObjectId, sometimes a populated doc —
// same normalization as ratingAlgorithm.service.js#_normalizeUserId, reused
// here since neither party on a Ticket is guaranteed unpopulated.
function normalizeUserId(user) {
    return user?._id || user;
}

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

// Money doesn't move through the platform yet (Duty.paymentMode is
// cash/upi/bank/will_pay_later, settled between the parties) — but payment
// disputes are already routed and adjudicated today, so an admin can
// legitimately propose one of these five actions on a live payment.* ticket.
// Per spec: "the five gated actions are inert behind a single flag. When
// mediated payouts ship, the flag turns on and the consequence engine
// already exists." Building the actual payout engine is a separate, larger
// effort — this only makes sure approving one of these today records
// cleanly (enforced:false) instead of throwing an unhandled error, same
// enforced:false precedent as APPLY_PRECAUTIONARY_RESTRICTION above.
function gatedPayoutHandler(actionName) {
    return async () => {
        const mediatedPayoutsEnabled = await systemConfigService.getEffective('payments.mediatedPayoutsEnabled');
        if (!mediatedPayoutsEnabled) {
            return { enforced: false };
        }
        // The flag flipping on is a future event this codebase doesn't
        // implement the other half of yet — fail loudly rather than silently
        // claim a payout happened that didn't.
        throw new UnprocessableEntityError(
            `${actionName} cannot be executed yet — mediated payouts are enabled but no payout engine is wired up.`
        );
    };
}

function assertApplicationSubject(ticket) {
    if (!['APPLICATION', 'INTERVIEW'].includes(ticket.subjectType) || !ticket.subjectId) {
        throw new UnprocessableEntityError('This action requires a job application as the ticket subject.');
    }
}

// Several JobApplication *ReasonText fields cap at REASON_TEXT_MAX_LENGTH
// (300, enforced by Mongoose maxlength) — `reason` here is
// ticket.actionTakenStatement, the full generated multi-paragraph statement,
// which routinely exceeds that. Truncate before writing into any capped
// field; the uncapped statusHistory/rescheduleHistory `reason` fields can
// hold it in full untouched.
function truncateReasonText(text) {
    if (!text) return null;
    return text.length > REASON_TEXT_MAX_LENGTH ? `${text.slice(0, REASON_TEXT_MAX_LENGTH - 1)}…` : text;
}

// recordOutcome()/markNoShow() (interviewScheduling.service.js) push a
// transient 'interviewed' marker into statusHistory without ever setting it
// as application.status — the doc jumps straight from confirmed to
// offered/rejected. Walking straight to statusHistory[length-2] would land
// REINSTATE_APPLICATION on a status no other precondition check treats as
// actionable. Skip past any 'interviewed' entries to find the real prior
// status.
function findPriorApplicationStatus(statusHistory) {
    for (let i = statusHistory.length - 2; i >= 0; i--) {
        if (statusHistory[i].status !== 'interviewed') return statusHistory[i].status;
    }
    return null;
}

// CORRECT_PROFILE_FIELD's target profile. Most calls resolve through the
// ticket's JobApplication subject; the fallback to raisedBy covers a
// category with no application subject at all (e.g. a direct
// data.correction_request). Never reads raisedAgainst — see the plan's
// resolutionClass table: none of these categories are ADJUDICATED, so
// raisedAgainst is schema-forbidden and always undefined on these tickets.
async function resolveProfileForTicket(ticket) {
    if (['APPLICATION', 'INTERVIEW'].includes(ticket.subjectType) && ticket.subjectId) {
        const application = await JobApplication.findById(ticket.subjectId).select('staff').lean();
        if (application) {
            const profile = await MedicalStaff.findById(application.staff);
            if (profile) return { profile, role: 'staff' };
        }
    }
    if (ticket.raisedBy.role === 'staff') {
        return { profile: await MedicalStaff.findOne({ user: ticket.raisedBy.user }), role: 'staff' };
    }
    if (ticket.raisedBy.role === 'hospital') {
        return { profile: await Hospital.findOne({ user: ticket.raisedBy.user }), role: 'hospital' };
    }
    return { profile: null, role: null };
}

// Conservative allowlist — mirrors profile.service.js#updateUserProfile's
// self-editable fields, minus email/phoneNumber (read-only there too) and
// minus location fields (city/currentAddress/state/pincode): correcting
// those without re-geocoding would leave `coordinates` silently stale for
// proximity search, out of scope for a data-correction action.
const PROFILE_FIELD_ALLOWLIST = {
    staff: ['fullName', 'jobRole', 'experience', 'profileSummary', 'skills', 'education'],
    hospital: ['hospitalLegalName']
};

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
    // the execution: ratingAlgorithm.service.js#getEffectiveRating is the
    // live reader that counts qualifying tickets (this one included) in a
    // trailing window and subtracts them from the damped review average.
    // The point value is derived from category, not admin-typed — every
    // admin applies the same number for the same category.
    APPLY_RATING_PENALTY: async (ticket) => {
        const points = RATING_PENALTY_POINTS_BY_CATEGORY[ticket.category];
        if (points === undefined) {
            throw new UnprocessableEntityError(`APPLY_RATING_PENALTY is not applicable to category ${ticket.category}.`);
        }
        // The penalty itself is never stamped on a profile (see comment
        // above) — but GET /api/profile/me caches its whole response for 15
        // minutes, and nothing else was invalidating it, so the respondent
        // could keep seeing their pre-penalty rating for up to that long.
        await cacheService.invalidateUserProfiles(normalizeUserId(ticket.raisedAgainst.user).toString());
        // TICKET_OUTCOME_DECIDED's own notification is too generic to tell
        // the respondent specifically what happened to their rating — see
        // notificationEmitter.js#emitRatingPenaltyApplied's own comment.
        await notificationEmitter.emitRatingPenaltyApplied(ticket, points);
        return { ratingDelta: points, appliedAt: new Date() };
    },

    // Only ever runs on an appeal ticket (ticket.appealOf points at the
    // original penalised ticket) — a pure stamp, same as before. The
    // reversal itself happens in ratingAlgorithm.service.js#_qualifyingPenalties,
    // which excludes any original ticket that has a decided appeal against
    // it carrying this action. Nothing here needs to know the original's
    // points or ratingDelta — "reversed" is a yes/no signal, not a math op.
    REVERSE_RATING_PENALTY: async (ticket) => {
        // Runs on the appeal ticket, so the appellant — whose rating is what
        // actually changes as a result — is raisedBy here, not raisedAgainst.
        await cacheService.invalidateUserProfiles(normalizeUserId(ticket.raisedBy.user).toString());

        // Look up the original ticket for the point value being restored,
        // and its own raiser — whoever's complaint the penalty came from,
        // and who otherwise gets no notice at all that it's been reversed
        // (emitAppealOutcome only ever notifies the appellant).
        if (ticket.appealOf) {
            const originalTicket = await Ticket.findById(ticket.appealOf)
                .select('ticketId raisedBy resolutionActions').lean();
            const originalEntry = originalTicket?.resolutionActions?.find(a => a.action === 'APPLY_RATING_PENALTY');
            const points = originalEntry?.details?.ratingDelta;
            if (points !== undefined) {
                await notificationEmitter.emitRatingPenaltyReversed(ticket, originalTicket, points);
            }
        }

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
    },

    // Hides a review found to be retaliatory or false — retained (see
    // Review.js's suppressed* fields), not deleted, but excluded from every
    // read path (review.service.js's two duty-scoped queries, plus
    // getStaffReviews/getHospitalReviews) and from the profile average it
    // once contributed to. Only category with resolutionClass ADJUDICATED
    // among these six, so it's the only one where ticket.raisedAgainst is
    // populated — used here as a cross-check against a stray reviewId, not
    // the primary lookup.
    SUPPRESS_REVIEW: async (ticket, entry, adminId, reason) => {
        if (!ticket.raisedAgainst) {
            throw new UnprocessableEntityError('SUPPRESS_REVIEW requires a ticket with a respondent.');
        }
        if (!entry.details?.reviewId) {
            throw new UnprocessableEntityError('SUPPRESS_REVIEW requires details.reviewId');
        }

        const review = await Review.findById(entry.details.reviewId);
        if (!review) {
            throw new UnprocessableEntityError('Review not found.');
        }
        if (review.suppressed) {
            throw new UnprocessableEntityError('This review has already been suppressed.');
        }

        const expectedReviewType = ticket.raisedAgainst.role === 'hospital' ? 'hospital_to_staff' : 'staff_to_hospital';
        if (review.reviewType !== expectedReviewType) {
            throw new UnprocessableEntityError("This review wasn't authored by the ticket's respondent.");
        }

        const isHospitalAuthored = review.reviewType === 'hospital_to_staff';
        const ProfileModel = isHospitalAuthored ? MedicalStaff : Hospital;
        const profile = await ProfileModel.findById(isHospitalAuthored ? review.medicalStaff : review.hospital);
        if (!profile) {
            throw new UnprocessableEntityError('The profile this review belongs to no longer exists.');
        }

        // Reverse running mean — exact inverse of review.service.js's
        // forward math (newAvg = ((avg*total)+rating)/(total+1)).
        const newTotal = Math.max(0, profile.totalRatings - 1);
        profile.averageRating = newTotal > 0
            ? Number((((profile.averageRating * profile.totalRatings) - review.rating) / newTotal).toFixed(2))
            : 0;
        profile.totalRatings = newTotal;
        await profile.save();

        review.suppressed = true;
        review.suppressedAt = new Date();
        review.suppressedReason = reason || null;
        review.suppressedBy = adminId;
        await review.save();

        // Two independent caches, both real staleness bugs otherwise: the
        // per-user profile cache, and the platform-average cache the
        // damping formula reads (1hr TTL, keyed by reviewType — not touched
        // by invalidateUserProfiles at all).
        await cacheService.invalidateUserProfiles(normalizeUserId(profile.user).toString());
        await ratingAlgorithmService.invalidatePlatformAverageCache(review.reviewType);

        return {
            reviewId: review._id,
            previousRating: review.rating,
            newAverageRating: profile.averageRating,
            newTotalRatings: profile.totalRatings
        };
    },

    // "Withdraws an application at the candidate's request" — an
    // admin-executed version of the candidate's own withdraw, routed
    // through a dispute rather than the self-service endpoint (e.g. the
    // candidate can't access their account and asked support directly).
    REVOKE_APPLICATION: async (ticket, entry, adminId, reason) => {
        assertApplicationSubject(ticket);
        const current = await JobApplication.findById(ticket.subjectId).select('status').lean();
        if (!current) {
            throw new UnprocessableEntityError('Application not found.');
        }
        if (TERMINAL_STATUSES.includes(current.status)) {
            throw new UnprocessableEntityError(`Cannot revoke an application that is already ${current.status}.`);
        }

        const updated = await adminService.adminOverrideApplicationStatus(
            ticket.subjectId, adminId, 'withdrawn', reason,
            { withdrawnAt: new Date(), withdrawReason: 'other', withdrawReasonText: truncateReasonText(reason) }
        );
        await notificationEmitter.emitApplicationWithdrawn(updated);
        return { revokedAt: updated.withdrawnAt };
    },

    // "Returns a revoked or rejected application to its prior state."
    REINSTATE_APPLICATION: async (ticket, entry, adminId, reason) => {
        assertApplicationSubject(ticket);
        const application = await JobApplication.findById(ticket.subjectId).select('status statusHistory').lean();
        if (!application) {
            throw new UnprocessableEntityError('Application not found.');
        }
        if (!['withdrawn', 'rejected'].includes(application.status)) {
            throw new UnprocessableEntityError(`REINSTATE_APPLICATION requires a withdrawn or rejected application (currently ${application.status}).`);
        }

        const priorStatus = findPriorApplicationStatus(application.statusHistory);
        if (!priorStatus || TERMINAL_STATUSES.includes(priorStatus)) {
            throw new UnprocessableEntityError('No valid prior state found to reinstate this application to.');
        }

        // adminOverrideApplicationStatus guards the {vacancy,staff} active-
        // status collision case (a fresh application filed since this one
        // went terminal) — see admin.service.js.
        const updated = await adminService.adminOverrideApplicationStatus(
            ticket.subjectId, adminId, priorStatus, reason,
            { rejectionReason: null, rejectionReasonText: null, withdrawnAt: null, withdrawReason: null, withdrawReasonText: null }
        );
        return { reinstatedTo: updated.status };
    },

    // "Returns an application to slots_offered." Deliberately bypasses
    // interview.rescheduleCap — see adminRescheduleInterview's own comment
    // in admin.service.js for why.
    RESCHEDULE_INTERVIEW: async (ticket, entry, adminId, reason) => {
        assertApplicationSubject(ticket);
        if (!Array.isArray(entry.details?.slots) || entry.details.slots.length === 0) {
            throw new UnprocessableEntityError('RESCHEDULE_INTERVIEW requires details.slots (at least one candidate interview slot).');
        }
        const application = await adminService.adminRescheduleInterview(
            ticket.subjectId, adminId,
            { slots: entry.details.slots, durationMinutes: entry.details.durationMinutes },
            reason
        );
        return { newOfferExpiresAt: application.interview.offer.expiresAt };
    },

    // "After a profile or parsing correction. Frozen snapshots stay
    // frozen." — recomputes only the one application named by
    // ticket.subjectId, using the exact same calls apply() uses. Every
    // other application's frozen matchScoreSnapshot is untouched, since
    // this handler never queries beyond ticket.subjectId.
    RECOMPUTE_MATCH_SCORE: async (ticket) => {
        assertApplicationSubject(ticket);
        const application = await JobApplication.findById(ticket.subjectId);
        if (!application) {
            throw new UnprocessableEntityError('Application not found.');
        }

        const [medicalStaff, vacancy] = await Promise.all([
            MedicalStaff.findById(application.staff).lean(),
            JobVacancy.findById(application.vacancy).lean()
        ]);
        if (!medicalStaff || !vacancy) {
            throw new UnprocessableEntityError('Cannot recompute — the candidate profile or vacancy no longer exists.');
        }

        const { matchScore, matchBreakdown } = vacancyMatchingService.computeMatchScore(medicalStaff, vacancy);
        const penalizedScore = await noShowPenaltyService.applyMatchScoreMultiplier(medicalStaff._id, matchScore);

        const previousScore = application.matchScoreSnapshot?.score ?? null;
        application.matchScoreSnapshot = {
            score: penalizedScore,
            breakdown: matchBreakdown,
            gateTier: jobApplicationService.deriveGateTier(matchBreakdown)
        };
        await application.save();

        return { previousScore, newScore: penalizedScore };
    },

    // "Writes a corrected value with provenance." Provenance is
    // correctionHistory[] on the profile itself (MedicalStaff.js/Hospital.js)
    // — visible directly on the profile, not just buried in the ticket.
    CORRECT_PROFILE_FIELD: async (ticket, entry, adminId, reason) => {
        const { field, value } = entry.details || {};
        if (!field) {
            throw new UnprocessableEntityError('CORRECT_PROFILE_FIELD requires details.field');
        }

        const { profile, role } = await resolveProfileForTicket(ticket);
        if (!profile) {
            throw new UnprocessableEntityError('Could not resolve a staff or hospital profile for this ticket.');
        }

        const allowlist = PROFILE_FIELD_ALLOWLIST[role] || [];
        if (!allowlist.includes(field)) {
            throw new UnprocessableEntityError(`CORRECT_PROFILE_FIELD cannot write to "${field}" for a ${role} profile.`);
        }

        const previousValue = profile[field];
        profile[field] = value;
        profile.correctionHistory = profile.correctionHistory || [];
        profile.correctionHistory.push({
            field, previousValue, newValue: value, correctedBy: adminId, correctedAt: new Date(),
            ticketId: ticket._id, reason: truncateReasonText(reason)
        });
        await profile.save();

        await cacheService.invalidateUserProfiles(normalizeUserId(profile.user).toString());

        return { field, previousValue, newValue: value };
    },

    HOLD_PAYOUT: gatedPayoutHandler('HOLD_PAYOUT'),
    RELEASE_PAYOUT: gatedPayoutHandler('RELEASE_PAYOUT'),
    ADJUST_PAYOUT: gatedPayoutHandler('ADJUST_PAYOUT'),
    RECOVER_FROM_FUTURE_PAYOUT: gatedPayoutHandler('RECOVER_FROM_FUTURE_PAYOUT'),
    REFUND_HOSPITAL: gatedPayoutHandler('REFUND_HOSPITAL')
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
