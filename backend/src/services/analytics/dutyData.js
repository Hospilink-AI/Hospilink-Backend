const Duty = require('../../models/Duty');
const Hospital = require('../../models/Hospital');

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Statuses a duty can only reach after someone accepted it
const FILLED_STATUSES = ['assigned', 'enroute', 'in-progress', 'pending-confirmation', 'completed', 'incomplete'];

// Base query for the role / urgency / city filters every section accepts
async function dutyFilter(filters = {}) {
    const query = {};
    if (filters.staffRole) query.staffRole = filters.staffRole;
    if (filters.urgency) query.urgency = filters.urgency;
    if (filters.city) {
        const hospitals = await Hospital.find({
            city: { $regex: `^${escapeRegex(filters.city.trim())}$`, $options: 'i' }
        }).select('_id').lean();
        query.hospital = { $in: hospitals.map(h => h._id) };
    }
    return query;
}

// Duties whose `field` falls in [start, end), only the fields asked for
async function loadDuties(field, start, end, filters, select, extra = {}) {
    const base = await dutyFilter(filters);
    return Duty.find({ ...base, ...extra, [field]: { $gte: start, $lt: end } }).select(select).lean();
}

// Accepted at some point, including duties the hospital cancelled after that
function wasFilled(duty) {
    return FILLED_STATUSES.includes(duty.status) || (duty.status === 'cancelled' && Boolean(duty.assignedTo));
}

// Cancelled by the hospital before anyone accepted it
function wasWithdrawn(duty) {
    return duty.status === 'cancelled' && !duty.assignedTo && duty.cancellation?.cancelledBy !== 'staff';
}

// Splits rows into the current and comparison period by one date field
function splitByPeriod(rows, dateOf, period) {
    const current = [];
    const previous = [];
    for (const row of rows) {
        const date = dateOf(row);
        if (!date) continue;
        if (date >= period.start && date < period.end) current.push(row);
        else if (date >= period.compareStart && date < period.compareEnd) previous.push(row);
    }
    return { current, previous };
}

module.exports = { FILLED_STATUSES, dutyFilter, loadDuties, wasFilled, wasWithdrawn, splitByPeriod };
