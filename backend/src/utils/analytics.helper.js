// Period, bucketing and number helpers for the admin analytics module.
// Pure functions only. Dates are IST days written as 'YYYY-MM-DD'.

const {
    istDateKey,
    istDayStart,
    addDaysToKey,
    daysBetweenKeys,
    isValidDateKey
} = require('./calendar.helper');

const GRANULARITIES = ['day', 'week', 'month'];
const MAX_RANGE_DAYS = 400;
const DEFAULT_RANGE_DAYS = 30;

// Picks a granularity that keeps a chart readable when none is asked for
function defaultGranularity(days) {
    if (days <= 62) return 'day';
    if (days <= 200) return 'week';
    return 'month';
}

// Resolves from/to/granularity into a period plus the previous period of the
// same length. Returns { error } instead of throwing, so validators can use it.
function parsePeriod(query = {}, todayKey = istDateKey(new Date())) {
    const to = query.to || todayKey;
    const from = query.from || addDaysToKey(to, -(DEFAULT_RANGE_DAYS - 1));

    if (!isValidDateKey(from) || !isValidDateKey(to)) {
        return { error: 'from and to must be dates in YYYY-MM-DD format' };
    }
    if (from > to) {
        return { error: 'from cannot be after to' };
    }

    const days = daysBetweenKeys(from, to) + 1;
    if (days > MAX_RANGE_DAYS) {
        return { error: `The range cannot be longer than ${MAX_RANGE_DAYS} days` };
    }

    const granularity = query.granularity || defaultGranularity(days);
    if (!GRANULARITIES.includes(granularity)) {
        return { error: `granularity must be one of: ${GRANULARITIES.join(', ')}` };
    }

    const compareTo = addDaysToKey(from, -1);
    const compareFrom = addDaysToKey(compareTo, -(days - 1));

    return {
        from,
        to,
        days,
        granularity,
        compareFrom,
        compareTo,
        start: istDayStart(from),
        end: istDayStart(addDaysToKey(to, 1)),
        compareStart: istDayStart(compareFrom),
        compareEnd: istDayStart(from)
    };
}

// Monday of the IST week a day key falls in
function weekKey(dayKey) {
    const [year, month, day] = dayKey.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
    return addDaysToKey(dayKey, -((weekday + 6) % 7));
}

function bucketKeyForDay(dayKey, granularity) {
    if (granularity === 'week') return weekKey(dayKey);
    if (granularity === 'month') return `${dayKey.slice(0, 7)}-01`;
    return dayKey;
}

function bucketKey(date, granularity) {
    return bucketKeyForDay(istDateKey(date), granularity);
}

// Every bucket between two day keys, for zero-filled series
function bucketsBetween(fromKey, toKey, granularity) {
    const keys = [];
    let current = bucketKeyForDay(fromKey, granularity);
    const last = bucketKeyForDay(toKey, granularity);
    while (current <= last) {
        keys.push(current);
        if (granularity === 'month') {
            const [year, month] = current.split('-').map(Number);
            current = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
        } else {
            current = addDaysToKey(current, granularity === 'week' ? 7 : 1);
        }
    }
    return keys;
}

// Builds a zero-filled series. fields maps a series name to a function
// returning that row's contribution (number) or to a constant 1 for counts.
function seriesFromRows(rows, dateOf, period, fields) {
    const keys = bucketsBetween(period.from, period.to, period.granularity);
    const index = new Map(keys.map(key => [key, Object.fromEntries(Object.keys(fields).map(f => [f, 0]))]));

    for (const row of rows) {
        const date = dateOf(row);
        if (!date) continue;
        const bucket = index.get(bucketKey(date, period.granularity));
        if (!bucket) continue;
        for (const [name, valueOf] of Object.entries(fields)) {
            bucket[name] += Number(valueOf(row)) || 0;
        }
    }

    return keys.map(key => ({ bucket: key, ...roundAll(index.get(key)) }));
}

function round(value, digits = 2) {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function roundAll(obj) {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, round(v)]));
}

// a / b as a 0-1 fraction, or null when there is nothing to divide by
function ratio(numerator, denominator, digits = 4) {
    return denominator ? round(numerator / denominator, digits) : null;
}

function deltaPct(current, previous) {
    if (current === null || previous === null || previous === undefined || previous === 0) return null;
    return round(((current - previous) / previous) * 100, 1);
}

function percentile(values, p) {
    const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

function median(values) {
    return percentile(values, 0.5);
}

function sum(values) {
    return values.reduce((total, v) => total + (Number(v) || 0), 0);
}

// Counts rows per key, largest first
function countBy(rows, keyOf, limit = null) {
    const counts = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (key === undefined || key === null || key === '') continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const result = [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count);
    return limit ? result.slice(0, limit) : result;
}

// Tile with its value for the previous period and the change between them
function tile(key, label, value, previous, unit, extra = {}) {
    return { key, label, value: round(value, 4), previous: round(previous, 4), deltaPct: deltaPct(value, previous), unit, ...extra };
}

// Moment a duty is scheduled to start: its IST date plus "HH:MM"
function scheduledStart(duty) {
    const [hours, minutes] = (duty.startTime || '00:00').split(':').map(Number);
    return new Date(istDayStart(istDateKey(duty.date)).getTime() + ((hours || 0) * 60 + (minutes || 0)) * 60000);
}

// Hours a duty is booked for, from its stored total and hourly rate
function dutyHours(duty) {
    return duty.offeredRate ? (duty.totalPayment || 0) / duty.offeredRate : 0;
}

module.exports = {
    GRANULARITIES,
    MAX_RANGE_DAYS,
    parsePeriod,
    weekKey,
    bucketKey,
    bucketsBetween,
    seriesFromRows,
    round,
    ratio,
    deltaPct,
    percentile,
    median,
    sum,
    countBy,
    tile,
    scheduledStart,
    dutyHours
};
