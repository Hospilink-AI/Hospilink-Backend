// Date rules for the duty calendar. All calendar dates are IST days written
// as 'YYYY-MM-DD'. Pure functions only, so they can be tested without a DB.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// IST calendar day of a stored date. Works whether the date was saved as
// UTC midnight or IST midnight of that day.
function istDateKey(date) {
    return new Date(new Date(date).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function isValidDateKey(value) {
    if (typeof value !== 'string' || !DATE_KEY_REGEX.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// Moment the IST day starts
function istDayStart(key) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
}

function addDaysToKey(key, days) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetweenKeys(fromKey, toKey) {
    return Math.round((istDayStart(toKey) - istDayStart(fromKey)) / DAY_MS);
}

// Mongo range for duties whose date falls on fromKey..toKey (inclusive)
function istDayRange(fromKey, toKey) {
    return { $gte: istDayStart(fromKey), $lt: istDayStart(addDaysToKey(toKey, 1)) };
}

// Same start-time rule the available-duties feed has always used
function hasDutyStarted(duty, now) {
    const dutyDateTime = new Date(duty.date);

    // Parse start time (format: "HH:MM" or "HH:MM AM/PM")
    const startTimeParts = (duty.startTime || '').match(/(\d+):(\d+)\s*(AM|PM)?/i);
    if (startTimeParts) {
        let hours = parseInt(startTimeParts[1]);
        const minutes = parseInt(startTimeParts[2]);
        const meridiem = startTimeParts[3];

        if (meridiem) {
            if (meridiem.toUpperCase() === 'PM' && hours !== 12) hours += 12;
            else if (meridiem.toUpperCase() === 'AM' && hours === 12) hours = 0;
        }

        dutyDateTime.setHours(hours, minutes, 0, 0);
    }

    return dutyDateTime <= now;
}

// An overnight duty belongs to its start date; the day it runs into only
// gets a continuation marker. Returns that day's key, or null.
function overnightContinuationKey(duty) {
    if (!duty.isOvernightDuty) return null;
    const startKey = istDateKey(duty.date);
    const endKey = duty.endDate ? istDateKey(duty.endDate) : null;
    return endKey && endKey > startKey ? endKey : addDaysToKey(startKey, 1);
}

module.exports = {
    istDateKey,
    isValidDateKey,
    istDayStart,
    addDaysToKey,
    daysBetweenKeys,
    istDayRange,
    hasDutyStarted,
    overnightContinuationKey
};
