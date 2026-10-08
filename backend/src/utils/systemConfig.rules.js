const { SLOT_DURATIONS } = require('./jobApplication.constants');

const integer = (min, max) => ({ kind: 'integer', min, max });
const number = (min, max) => ({ kind: 'number', min, max });

// Keys with an explicit rule. Any other known key falls back to a check
// derived from the type of its default (see checkAgainstDefault).
const RULES = {
    'interview.slotDurationDefault': { kind: 'oneOf', values: SLOT_DURATIONS },
    'interview.slotsPerOfferMin': integer(1, 20),
    'interview.slotsPerOfferMax': integer(1, 20),
    'interview.schedulingWindowMinHours': integer(0, 720),
    'interview.schedulingWindowMaxDays': integer(1, 365),
    'interview.offerExpiryDays': integer(1, 90),
    'interview.confirmationExpiryDays': integer(1, 90),
    'interview.nudgeScheduleDays': { kind: 'ascendingIntegers', min: 1, max: 90, maxLength: 10 },
    'interview.joinWindowBeforeMin': integer(0, 120),
    'interview.joinWindowAfterMin': integer(0, 240),
    'interview.lateChangeThresholdHours': integer(0, 72),
    'interview.rescheduleCap': integer(0, 10),
    'interview.noShowGraceMin': integer(0, 120),
    'interview.outcomeRecordingWindowDays': integer(1, 90),
    'interview.disputeWindowDays': integer(1, 90),
    'interview.noShowScoreMultiplier': number(0, 1),
    'interview.noShowScoreFloor': number(0, 1),
    'ticket.botConfidenceThresholdEn': number(0, 1),
    'ticket.botConfidenceThresholdHiMr': number(0, 1),
    'ticket.clawbackCapPercent': number(0, 100),

    // Auto-relist (staff-cancellation recovery). Bounds are sanity
    // guardrails, same spirit as the interview ones above — not business
    // policy. 'autoRelist.featureDefaultEnabled' has no explicit rule; it
    // falls back to checkAgainstDefault's boolean check.
    'autoRelist.lateCancellationBandMinutes': integer(15, 240),
    'autoRelist.staffCancelCutoffMinutes': integer(5, 120),
    'autoRelist.rateBoostFraction': number(0, 1),
    'autoRelist.relistCap': integer(1, 10),
    'autoRelist.repeatPushScheduleMinutes': { kind: 'ascendingIntegers', min: 1, max: 120, maxLength: 5 },
    'autoRelist.notificationRadiusKm': integer(10, 200),
    'autoRelist.staffWatchlistWindowDays': integer(1, 180),
    'autoRelist.staffWatchlistThresholdCount': integer(1, 20),
    'autoRelist.pairWatchlistThresholdCount': integer(1, 20),
    'autoRelist.hospitalWatchlistMultiplier': number(1, 10),

    // Duty calendar
    'calendar.weekStart': { kind: 'oneOf', values: ['monday', 'sunday'] },
    'calendar.prefetchPeriods': integer(0, 3),
    'calendar.countsCacheSeconds': integer(0, 600),
    'calendar.bookingHorizonDays': integer(7, 365),
    'calendar.historyDays': integer(7, 730),
    'calendar.batchNotificationThreshold': integer(2, 50),

    // Admin analytics
    'analytics.liveCacheSeconds': integer(0, 3600),
    'privacy.mapLocationPrecisionKm': number(0, 10),
    'analytics.projectedCommissionPercent': number(0, 50),
    'analytics.revenueSource': { kind: 'oneOf', values: ['projected', 'ledger'] },

    // Staged duty offers
    'offer.startRadiusKm': integer(5, 100),
    'offer.stepKm': integer(1, 50),
    'offer.stepMinutes': integer(5, 720),
    'offer.maxRadiusKm': integer(5, 200),
    'offer.inviteWindowMinutes': integer(5, 240),
    'offer.availabilityHeadStartMinutes': integer(0, 60),

    // Market-rate suggestions: inside the duty price rules (₹499-₹9,999, 3-24 hours)
    'pricing.rmoCasualtyTotal': integer(499, 9999),
    'pricing.rmoCasualtyHours': integer(3, 24),
    'pricing.rmoIcuTotal': integer(499, 9999),
    'pricing.rmoIcuHours': integer(3, 24)
};

// Rules that compare two keys. Checked against the *other* key's current
// effective value, so raising a min above the current max is rejected — the
// admin raises the max first, then the min.
const CROSS_KEY_RULES = [
    {
        keys: ['interview.slotsPerOfferMin', 'interview.slotsPerOfferMax'],
        check: (min, max) => min <= max,
        message: 'interview.slotsPerOfferMin cannot be greater than interview.slotsPerOfferMax'
    },
    {
        keys: ['interview.schedulingWindowMinHours', 'interview.schedulingWindowMaxDays'],
        check: (minHours, maxDays) => minHours < maxDays * 24,
        message: 'interview.schedulingWindowMinHours must be shorter than interview.schedulingWindowMaxDays, or no slot could ever be valid'
    },
    {
        keys: ['autoRelist.staffCancelCutoffMinutes', 'autoRelist.lateCancellationBandMinutes'],
        check: (cutoff, band) => cutoff < band,
        message: 'autoRelist.staffCancelCutoffMinutes must be shorter than autoRelist.lateCancellationBandMinutes, or the late-cancellation band would never apply'
    },
    {
        keys: ['offer.startRadiusKm', 'offer.maxRadiusKm'],
        check: (start, max) => start <= max,
        message: 'offer.startRadiusKm cannot be greater than offer.maxRadiusKm'
    }
];

function checkRule(key, value, rule) {
    switch (rule.kind) {
        case 'oneOf':
            return rule.values.includes(value) ? null : `${key} must be one of: ${rule.values.join(', ')}`;

        case 'integer':
            return Number.isInteger(value) && value >= rule.min && value <= rule.max
                ? null
                : `${key} must be a whole number between ${rule.min} and ${rule.max}`;

        case 'number':
            return Number.isFinite(value) && value >= rule.min && value <= rule.max
                ? null
                : `${key} must be a number between ${rule.min} and ${rule.max}`;

        case 'ascendingIntegers': {
            const valid = Array.isArray(value)
                && value.length >= 1
                && value.length <= rule.maxLength
                && value.every((n, i) => Number.isInteger(n) && n >= rule.min && n <= rule.max && (i === 0 || n > value[i - 1]));
            return valid
                ? null
                : `${key} must be an ascending list of 1-${rule.maxLength} whole numbers between ${rule.min} and ${rule.max}`;
        }

        default:
            return null;
    }
}

function checkAgainstDefault(key, value, defaultValue) {
    if (typeof defaultValue === 'boolean') {
        return typeof value === 'boolean' ? null : `${key} must be true or false`;
    }
    if (typeof defaultValue === 'number') {
        return Number.isFinite(value) && value >= 0 ? null : `${key} must be a non-negative number`;
    }
    if (Array.isArray(defaultValue)) {
        return Array.isArray(value) ? null : `${key} must be a list`;
    }
    return null;
}

// Returns an error message, or null when the value is acceptable. Pure —
// cross-key rules need the DB and live in SystemConfigService#validateUpdate.
function validateValue(key, value, defaultValue) {
    const rule = RULES[key];
    return rule ? checkRule(key, value, rule) : checkAgainstDefault(key, value, defaultValue);
}

module.exports = { RULES, CROSS_KEY_RULES, validateValue };
