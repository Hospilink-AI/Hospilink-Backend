const { istDateKey } = require('../../utils/calendar.helper');

const monthKey = (date) => istDateKey(date).slice(0, 7);
const monthIndex = (key) => {
    const [year, month] = key.split('-').map(Number);
    return year * 12 + (month - 1);
};
const keyFromIndex = (index) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

// Monthly retention: entities grouped by the month of their first activity,
// then the share of each group active again N months later.
//   firstSeen: Map(id -> Date of first activity, ever)
//   activity:  [{ id, at: Date }] activity rows covering the cohort window
//   lastMonth: 'YYYY-MM' to end on (usually this month)
function buildCohorts(firstSeen, activity, lastMonth, monthsBack = 12) {
    const last = monthIndex(lastMonth);
    const first = last - monthsBack + 1;

    const activeMonths = new Map();
    for (const { id, at } of activity) {
        if (!id || !at) continue;
        const key = String(id);
        if (!activeMonths.has(key)) activeMonths.set(key, new Set());
        activeMonths.get(key).add(monthIndex(monthKey(at)));
    }

    const cohorts = new Map();
    for (const [id, date] of firstSeen) {
        const index = monthIndex(monthKey(date));
        if (index < first || index > last) continue;
        if (!cohorts.has(index)) cohorts.set(index, []);
        cohorts.get(index).push(String(id));
    }

    const rows = [];
    for (let index = first; index <= last; index++) {
        const members = cohorts.get(index) || [];
        const retention = [];
        for (let offset = 0; index + offset <= last; offset++) {
            if (members.length === 0) {
                retention.push(null);
                continue;
            }
            const active = members.filter(id => activeMonths.get(id)?.has(index + offset)).length;
            retention.push(Math.round((active / members.length) * 1000) / 1000);
        }
        rows.push({ cohort: keyFromIndex(index), size: members.length, retention });
    }

    return { monthsBack, rows };
}

module.exports = { buildCohorts, monthKey };
