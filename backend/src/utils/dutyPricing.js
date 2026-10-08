// Price rules for duties (client decision, 7 Oct 2026). The new hospital app
// checks the same numbers; the server checks them for old apps and admin screens.
const { calculateDutyDuration } = require('./helpers');

const MIN_TOTAL = 499;
const MAX_TOTAL = 9999;
const MIN_HOURS = 3;
const MAX_HOURS = 24;

const TIME_REGEX = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

const formatRupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

function toDate(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

// Hours and total the same way the Duty pre-save hook works them out.
// Returns null when the fields needed are missing or malformed.
function dutyHoursAndTotal({ date, endDate, startTime, endTime, isOvernightDuty, offeredRate }) {
    const start = toDate(date);
    if (!start || !TIME_REGEX.test(startTime || '') || !TIME_REGEX.test(endTime || '')) return null;
    const hours = calculateDutyDuration(start, startTime, endTime, Boolean(isOvernightDuty), toDate(endDate) || undefined);
    const rate = Number(offeredRate);
    const total = Number.isFinite(rate) ? Math.round(rate * hours * 100) / 100 : null;
    return { hours, total };
}

// The first rule a duty breaks, as a plain sentence, or null. Anesthesia
// bookings have no price limit for now but keep the hour rules.
function priceRuleError(fields) {
    const result = dutyHoursAndTotal(fields);
    if (!result) return null;
    const { hours, total } = result;

    if (hours < MIN_HOURS) return `A duty must be at least ${MIN_HOURS} hours long.`;
    if (hours > MAX_HOURS) return `A duty can't be longer than ${MAX_HOURS} hours.`;

    if (fields.category === 'anesthesia' || total === null) return null;
    if (total < MIN_TOTAL) return `The total must be at least ${formatRupees(MIN_TOTAL)}.`;
    if (total > MAX_TOTAL) return `The total can't be more than ${formatRupees(MAX_TOTAL)}.`;
    return null;
}

module.exports = {
    MIN_TOTAL,
    MAX_TOTAL,
    MIN_HOURS,
    MAX_HOURS,
    dutyHoursAndTotal,
    priceRuleError,
    formatRupees
};
