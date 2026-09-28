const Duty = require('../models/Duty');
const { getCurrentIST } = require('../utils/helpers');
const {
    STAFF_CANCEL_CUTOFF_MINUTES,
    LATE_CANCELLATION_BAND_MINUTES,
    RATE_BOOST_FRACTION,
    RATE_ROUNDING_UNIT,
    URGENCY_LEVELS,
    URGENCY_AUTO_ESCALATION_CEILING,
    RELIST_CAP
} = require('../utils/dutyCancellation.constants');

function roundUpToNearest(value, unit) {
    return Math.ceil(value / unit) * unit;
}


function escalateUrgency(currentUrgency) {
    const ceilingIndex = URGENCY_LEVELS.indexOf(URGENCY_AUTO_ESCALATION_CEILING);
    const currentIndex = URGENCY_LEVELS.indexOf(currentUrgency);

    if (currentIndex === -1 || currentIndex >= ceilingIndex) {
        return currentUrgency;
    }
    return URGENCY_LEVELS[currentIndex + 1];
}



// Every cancellation must be recorded here regardless of the hospital's
// autoRelist.enabled setting — this array is the single source of truth for
// "how many times has this staff member cancelled late," used by the
// staff/pair watchlists (guardrail 06.05: "every cancellation still counts
// against the staff member... auto-relist recovers the shift; it does not
// absolve the cancellation"). Skipping this write for opted-out duties would
// make those cancellations invisible to that count.
function pushHistoryEntry(duty, { cancellingStaffId, minutesUntilStart, reason, reasonText, urgencyBefore, urgencyAfter, rateBefore, rateAfter }) {
    duty.autoRelist.history = duty.autoRelist.history || [];
    duty.autoRelist.history.push({
        timestamp: getCurrentIST(),
        cancelledBy: cancellingStaffId,
        reason,
        reasonText: reasonText || null,
        minutesBeforeStart: minutesUntilStart,
        urgencyBefore,
        urgencyAfter,
        rateBefore,
        rateAfter
    });
}

function applyRelist(duty, { cancellingStaffId, minutesUntilStart, reason, reasonText, enabled = true, config = {} }) {
    const {
        staffCancelCutoffMinutes = STAFF_CANCEL_CUTOFF_MINUTES,
        lateCancellationBandMinutes = LATE_CANCELLATION_BAND_MINUTES,
        rateBoostFraction = RATE_BOOST_FRACTION,
        relistCap = RELIST_CAP
    } = config;

    if (!duty.autoRelist) {
        duty.autoRelist = {};
    }

    duty.autoRelist.excludedStaff = duty.autoRelist.excludedStaff || [];
    duty.autoRelist.excludedStaff.push(cancellingStaffId);
    duty.unassigned15MinNotified = false;

    if (!enabled) {
        pushHistoryEntry(duty, {
            cancellingStaffId, minutesUntilStart, reason, reasonText,
            urgencyBefore: duty.urgency, urgencyAfter: duty.urgency,
            rateBefore: duty.offeredRate, rateAfter: duty.offeredRate
        });

        return {
            boosted: false,
            capReached: false,
            wasAtCap: false,
            skipped: true,
            urgencyBefore: duty.urgency,
            urgencyAfter: duty.urgency,
            rateBefore: duty.offeredRate,
            rateAfter: duty.offeredRate,
            relistCount: duty.autoRelist.relistCount || 0
        };
    }

    const wasAtCap = (duty.autoRelist.relistCount || 0) >= relistCap;
    const urgencyBefore = duty.urgency;
    const rateBefore = duty.offeredRate;
    let boosted = false;

    // Fresh relist cycle — reset the repeat-push budget (spec §05: up to
    // 3 pushes per cancellation, not a lifetime total across relists).
    duty.autoRelist.repeatPushCount = 0;

    if (!wasAtCap) {
        duty.urgency = escalateUrgency(duty.urgency);

        // minutesUntilStart >= staffCancelCutoffMinutes is already
        // guaranteed by cancellation.service.js's validation before this
        // runs — checked again here since this function makes no
        // assumptions about its caller.
        const isLateBand = minutesUntilStart < lateCancellationBandMinutes &&
            minutesUntilStart >= staffCancelCutoffMinutes;

        if (isLateBand && !duty.autoRelist.rateBoostApplied) {
            if (duty.autoRelist.originalOfferedRate == null) {
                duty.autoRelist.originalOfferedRate = duty.offeredRate;
            }
            const boostedRate = duty.offeredRate * (1 + rateBoostFraction);
            duty.offeredRate = roundUpToNearest(boostedRate, RATE_ROUNDING_UNIT);
            duty.autoRelist.rateBoostApplied = true;
            boosted = true;
        }
    }

    duty.autoRelist.relistCount = (duty.autoRelist.relistCount || 0) + 1;
    const capReached = !wasAtCap && duty.autoRelist.relistCount >= relistCap;

    pushHistoryEntry(duty, {
        cancellingStaffId, minutesUntilStart, reason, reasonText,
        urgencyBefore, urgencyAfter: duty.urgency,
        rateBefore, rateAfter: duty.offeredRate
    });

    return {
        boosted,
        capReached,
        wasAtCap,
        skipped: false,
        urgencyBefore,
        urgencyAfter: duty.urgency,
        rateBefore,
        rateAfter: duty.offeredRate,
        relistCount: duty.autoRelist.relistCount
    };
}

// Counts distinct duties a staff member has cancelled within a trailing
// window, from Duty.autoRelist.history — the durable record every
// cancellation writes to regardless of the hospital's autoRelist.enabled
// setting (see pushHistoryEntry above). A staff member appears at most once
// per duty's history (excludedStaff blocks them from ever cancelling the
// same duty twice), so counting matching duties is equivalent to counting
// cancellation events.
//
// This is the read side of guardrail 06.05 and the data source for the
// staff watchlist (spec §07) — deliberately NOT PatternFlag-based.
// PatternFlag.casesRelied is a required ref: 'Ticket' array and the model's
// own design intent is "never a shadow record, always ticket-backed
// evidence the flagged party can see" (patternEngine.service.js's
// evaluateForTicket is its only entry point). A staff cancellation is never
// a ticket, so this stays a duty-native concept instead of forcing a fake
// ticket into that engine or weakening its evidence guarantee.
async function countStaffCancellations(medicalStaffId, { windowDays, lateBandOnly = false, lateBandMinutes = LATE_CANCELLATION_BAND_MINUTES } = {}) {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const historyMatch = { cancelledBy: medicalStaffId, timestamp: { $gte: cutoff } };
    if (lateBandOnly) {
        historyMatch.minutesBeforeStart = { $lt: lateBandMinutes };
    }
    return Duty.countDocuments({ 'autoRelist.history': { $elemMatch: historyMatch } });
}

module.exports = { applyRelist, escalateUrgency, roundUpToNearest, countStaffCancellations };
