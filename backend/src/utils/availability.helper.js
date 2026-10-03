// Reads a doctor's declared availability for a day. Pure, so it can be
// tested without a database. Dates are IST 'YYYY-MM-DD'.

const { istDateKey } = require('./calendar.helper');

const weekdayOf = (dateKey) => {
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

const toMinutes = (time) => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
};

// { status: 'free' | 'busy' | 'unknown', from, to, source: 'exception' | 'weekly' | null }
function resolveDay(availability, dateKey) {
    if (!availability) return { status: 'unknown', from: null, to: null, source: null };

    const exception = (availability.exceptions || []).find(e => e.date === dateKey);
    if (exception) {
        return { status: exception.status, from: exception.from || null, to: exception.to || null, source: 'exception' };
    }

    const patternActive = availability.validUntil && dateKey <= istDateKey(availability.validUntil);
    if (patternActive) {
        const entry = (availability.weekly || []).find(w => w.day === weekdayOf(dateKey));
        if (entry) return { status: 'free', from: entry.from || null, to: entry.to || null, source: 'weekly' };
    }

    return { status: 'unknown', from: null, to: null, source: null };
}

// Is the doctor free for this whole shift? A day with no hours given counts
// as free all day. Overnight shifts only need the start day to be free.
function isFreeFor(availability, dateKey, startTime, endTime) {
    const day = resolveDay(availability, dateKey);
    if (day.status !== 'free') return false;
    if (!day.from || !day.to || !startTime) return true;

    const start = toMinutes(startTime);
    const end = endTime ? toMinutes(endTime) : start;
    const from = toMinutes(day.from);
    const to = toMinutes(day.to);
    if (end <= start) return start >= from && to >= toMinutes('23:59'); // runs past midnight
    return start >= from && end <= to;
}

module.exports = { resolveDay, isFreeFor, weekdayOf };
