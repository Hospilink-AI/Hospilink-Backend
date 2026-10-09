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

const CASE_NOTE_MIN = 10;
const CASE_NOTE_MAX = 600;
const MAX_FIXED_PRICE = 1000000;

// Problems with an anesthesia booking's fields, as plain sentences
function anesthesiaErrors(body) {
    const errors = [];
    if (body.category === undefined) return errors;
    if (!['standard', 'anesthesia'].includes(body.category)) {
        errors.push('category must be standard or anesthesia');
        return errors;
    }
    if (body.category !== 'anesthesia') return errors;

    if (body.staff_role !== 'anesthetist') {
        errors.push('Anesthesia bookings are for anesthetists only.');
    }
    if (body.pricing_mode !== undefined && body.pricing_mode !== 'fixed') {
        errors.push('Anesthesia bookings have one price for the case.');
    }
    const price = body.fixed_price === null || body.fixed_price === '' ? NaN : Number(body.fixed_price);
    if (!Number.isFinite(price) || price <= 0 || price > MAX_FIXED_PRICE) {
        errors.push('Enter the price for the case.');
    }
    const note = typeof body.case_note === 'string' ? body.case_note.trim() : '';
    if (note.length < CASE_NOTE_MIN) {
        errors.push(`Describe the case in at least ${CASE_NOTE_MIN} characters.`);
    } else if (note.length > CASE_NOTE_MAX) {
        errors.push(`The case note can't be longer than ${CASE_NOTE_MAX} characters.`);
    }
    return errors;
}

// Model fields for an anesthesia booking from the create request, or {}
function anesthesiaFields(body) {
    if (body.category !== 'anesthesia') return {};
    return {
        category: 'anesthesia',
        pricing: { mode: 'fixed' },
        fixedPrice: Math.round(Number(body.fixed_price) * 100) / 100,
        caseNote: body.case_note.trim()
    };
}

const RECOMMENDATION_KEYS = ['pricing.rmoCasualtyTotal', 'pricing.rmoCasualtyHours', 'pricing.rmoIcuTotal', 'pricing.rmoIcuHours'];

// Price rules and market-rate suggestions for the hospital's Create duty screen
async function pricingForHospitals() {
    const systemConfigService = require('../services/systemConfig.service');
    const cfg = await systemConfigService.getManyEffective(RECOMMENDATION_KEYS);
    return {
        minTotal: MIN_TOTAL,
        maxTotal: MAX_TOTAL,
        minHours: MIN_HOURS,
        maxHours: MAX_HOURS,
        recommendations: {
            rmo: {
                casualty: { total: cfg['pricing.rmoCasualtyTotal'], hours: cfg['pricing.rmoCasualtyHours'] },
                icu: { total: cfg['pricing.rmoIcuTotal'], hours: cfg['pricing.rmoIcuHours'] }
            }
        }
    };
}

module.exports = {
    anesthesiaErrors,
    anesthesiaFields,
    pricingForHospitals,
    MIN_TOTAL,
    MAX_TOTAL,
    MIN_HOURS,
    MAX_HOURS,
    dutyHoursAndTotal,
    priceRuleError,
    formatRupees
};
