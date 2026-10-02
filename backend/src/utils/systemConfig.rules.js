// Guardrails for admin edits to SystemConfig values. The store itself
// (models/SystemConfig.js) is schema-less — `value` is Mixed — so without
// these an admin typo (a string where a number belongs, a min above a max) is
// saved as-is, every server check that reads it misbehaves, and, now that
// staff and hospitals read the interview keys via GET /api/interview/config,
// every client screen does too.
//
// The bounds are sanity guardrails that catch typos (300 slots per offer),
// not business policy — widen them here if the business genuinely needs more.

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
    'ticket.clawbackCapPercent': number(0, 100)
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
