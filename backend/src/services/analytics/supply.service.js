const Duty = require('../../models/Duty');
const MedicalStaff = require('../../models/MedicalStaff');
const snapshotService = require('./snapshot.service');
const { buildCohorts, monthKey } = require('./cohorts');
const { splitByPeriod } = require('./dutyData');
const { istDateKey, istDayStart, addDaysToKey } = require('../../utils/calendar.helper');
const {
    tile, ratio, round, median, countBy, seriesFromRows
} = require('../../utils/analytics.helper');

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (value) => ({ $regex: `^${escapeRegex(value.trim())}$`, $options: 'i' });

const RATING_BANDS = [
    { key: '1to2', label: '1-2', max: 2 },
    { key: '2to3', label: '2-3', max: 3 },
    { key: '3to4', label: '3-4', max: 4 },
    { key: '4to4.5', label: '4-4.5', max: 4.5 },
    { key: '4.5to5', label: '4.5-5', max: Infinity }
];

const hoursBetween = (from, to) => (new Date(to) - new Date(from)) / 3600000;

class SupplyAnalytics {
    // Staff filters: city and role match the staff profile
    _staffFilter(filters) {
        const query = {};
        if (filters.city) query.city = exact(filters.city);
        if (filters.staffRole) query.jobRole = exact(filters.staffRole);
        return query;
    }

    async build(period, filters) {
        const staffQuery = this._staffFilter(filters);
        const staffIds = Object.keys(staffQuery).length
            ? (await MedicalStaff.find(staffQuery).select('_id').lean()).map(s => s._id)
            : null;
        const dutyScope = staffIds ? { assignedTo: { $in: staffIds } } : {};

        const cohortStart = istDayStart(`${addDaysToKey(`${istDateKey(new Date()).slice(0, 7)}-01`, -335).slice(0, 7)}-01`);

        const [signups, verifiedInPeriod, allStaff, completed, firstDuties, cohortActivity, snapshots] = await Promise.all([
            MedicalStaff.find({ ...staffQuery, createdAt: { $gte: period.compareStart, $lt: period.end } })
                .select('createdAt isProfileComplete isDocumentsUploaded verificationStatus').lean(),
            MedicalStaff.find({ ...staffQuery, verifiedAt: { $gte: period.compareStart, $lt: period.end } })
                .select('createdAt verifiedAt').lean(),
            MedicalStaff.find(staffQuery)
                .select('jobRole city experience profileSource verificationStatus isAvailable isSuspended averageRating totalRatings').lean(),
            Duty.find({ ...dutyScope, status: 'completed', completedAt: { $gte: period.compareStart, $lt: period.end } })
                .select('assignedTo completedAt totalPayment').lean(),
            Duty.aggregate([
                { $match: { ...dutyScope, status: 'completed', assignedTo: { $ne: null } } },
                { $group: { _id: '$assignedTo', first: { $min: '$completedAt' } } }
            ]),
            Duty.find({ ...dutyScope, status: 'completed', completedAt: { $gte: cohortStart } })
                .select('assignedTo completedAt').lean(),
            snapshotService.getSnapshots(period.compareTo, period.to)
        ]);

        const signupSplit = splitByPeriod(signups, s => s.createdAt, period);
        const verifiedSplit = splitByPeriod(verifiedInPeriod, s => s.verifiedAt, period);
        const completedSplit = splitByPeriod(completed, d => d.completedAt, period);
        const firstById = new Map(firstDuties.filter(r => r._id && r.first).map(r => [r._id.toString(), r.first]));

        const measure = (signupRows, verifiedRows, completedRows, start, end) => {
            const active = new Set(completedRows.filter(d => d.assignedTo).map(d => d.assignedTo.toString()));
            const newActive = [...active].filter(id => {
                const first = firstById.get(id);
                return first && first >= start && first < end;
            });
            return {
                signups: signupRows.length,
                signupsVerified: ratio(signupRows.filter(s => s.verificationStatus === 'verified').length, signupRows.length),
                medianTimeToVerify: median(verifiedRows.map(s => hoursBetween(s.createdAt, s.verifiedAt))),
                verifiedCount: verifiedRows.length,
                activeStaff: active.size,
                newActiveStaff: newActive.length,
                utilisation: ratio(completedRows.length, active.size, 2),
                activeIds: active
            };
        };

        const cur = measure(signupSplit.current, verifiedSplit.current, completedSplit.current, period.start, period.end);
        const prev = measure(signupSplit.previous, verifiedSplit.previous, completedSplit.previous, period.compareStart, period.compareEnd);
        const churned = [...prev.activeIds].filter(id => !cur.activeIds.has(id)).length;

        const verifiedStaff = allStaff.filter(s => s.verificationStatus === 'verified' && !s.isSuspended);
        const availabilityNow = ratio(verifiedStaff.filter(s => s.isAvailable).length, verifiedStaff.length);
        const previousSnapshot = snapshots.find(s => s.date === period.compareTo);
        const availabilityBefore = previousSnapshot
            ? ratio(previousSnapshot.stocks?.staff?.available, previousSnapshot.stocks?.staff?.verified)
            : null;

        const tiles = [
            tile('staffSignups', 'Staff signups', cur.signups, prev.signups, 'count'),
            tile('signupsVerified', 'Signups now verified', cur.signupsVerified, prev.signupsVerified, 'ratio'),
            tile('staffVerified', 'Staff verified', cur.verifiedCount, prev.verifiedCount, 'count'),
            tile('staffTimeToVerify', 'Median signup to verification', cur.medianTimeToVerify, prev.medianTimeToVerify, 'hours'),
            tile('activeStaff', 'Staff who completed a duty', cur.activeStaff, prev.activeStaff, 'count'),
            tile('newActiveStaff', 'Staff who completed their first duty', cur.newActiveStaff, prev.newActiveStaff, 'count'),
            tile('utilisation', 'Completed duties per active staff', cur.utilisation, prev.utilisation, 'ratio'),
            tile('churnedStaff', 'Active last period, not this period', churned, null, 'count'),
            tile('availabilityRate', 'Verified staff available now', availabilityNow, availabilityBefore, 'ratio')
        ];

        const topEarners = await this._topEarners(completedSplit.current);

        const charts = [
            {
                key: 'signupTrend',
                type: 'line',
                title: 'Staff signups',
                series: seriesFromRows(signupSplit.current, s => s.createdAt, period, {
                    signups: () => 1,
                    verified: s => (s.verificationStatus === 'verified' ? 1 : 0)
                })
            },
            {
                key: 'verificationFunnel',
                type: 'funnel',
                title: 'Signups in this period, by how far they got',
                stages: [
                    { key: 'signedUp', label: 'Signed up', value: signupSplit.current.length },
                    { key: 'profileComplete', label: 'Profile complete', value: signupSplit.current.filter(s => s.isProfileComplete).length },
                    { key: 'documentsUploaded', label: 'Documents uploaded', value: signupSplit.current.filter(s => s.isDocumentsUploaded).length },
                    { key: 'verified', label: 'Verified', value: signupSplit.current.filter(s => s.verificationStatus === 'verified').length }
                ]
            },
            {
                key: 'availabilityTrend',
                type: 'line',
                title: 'Verified and available staff (daily snapshot)',
                series: snapshots.filter(s => s.date >= period.from).map(s => ({
                    bucket: s.date,
                    verified: s.stocks?.staff?.verified ?? null,
                    available: s.stocks?.staff?.available ?? null
                }))
            },
            { key: 'retentionCohorts', type: 'cohort', title: 'Staff still completing duties, by month of first duty', ...this._cohorts(firstById, cohortActivity) },
            { key: 'byRole', type: 'table', title: 'Verified staff by role', rows: countBy(verifiedStaff, s => s.jobRole) },
            { key: 'byCity', type: 'table', title: 'Verified staff by city', rows: countBy(verifiedStaff, s => s.city?.trim(), 20) },
            { key: 'byExperience', type: 'bar', title: 'Verified staff by experience', rows: countBy(verifiedStaff, s => s.experience) },
            { key: 'byProfileSource', type: 'donut', title: 'How profiles were filled', rows: countBy(allStaff, s => s.profileSource || 'manual') },
            { key: 'ratingDistribution', type: 'bar', title: 'Staff average rating (rated staff only)', rows: this._ratingBands(allStaff) },
            { key: 'topEarners', type: 'table', title: 'Top earners in the period', rows: topEarners }
        ];

        return {
            tiles,
            charts,
            dataNotes: [
                'Time to verify only covers staff verified after verifiedAt started being recorded.',
                'Retention cohorts group staff by the month of their first completed duty.'
            ]
        };
    }



    _cohorts(firstById, activity) {
        return buildCohorts(
            firstById,
            activity.map(d => ({ id: d.assignedTo, at: d.completedAt })),
            monthKey(new Date())
        );
    }



    _ratingBands(staff) {
        const bands = RATING_BANDS.map(b => ({ band: b.key, label: b.label, max: b.max, staff: 0 }));
        for (const s of staff) {
            if (!s.totalRatings) continue;
            const band = bands.find(b => (s.averageRating || 0) < b.max) || bands[bands.length - 1];
            band.staff++;
        }
        return bands.map(({ max, ...rest }) => rest);
    }



    async _topEarners(completedRows) {
        const byStaff = new Map();
        for (const duty of completedRows) {
            if (!duty.assignedTo) continue;
            const id = duty.assignedTo.toString();
            const entry = byStaff.get(id) || { earned: 0, duties: 0 };
            entry.earned += duty.totalPayment || 0;
            entry.duties++;
            byStaff.set(id, entry);
        }

        const ranked = [...byStaff.entries()].sort((a, b) => b[1].earned - a[1].earned).slice(0, 10);
        const staff = await MedicalStaff.find({ _id: { $in: ranked.map(([id]) => id) } }).select('fullName jobRole city').lean();
        const byId = new Map(staff.map(s => [s._id.toString(), s]));

        return ranked.map(([id, entry]) => ({
            staffId: id,
            name: byId.get(id)?.fullName || '—',
            jobRole: byId.get(id)?.jobRole || null,
            city: byId.get(id)?.city || null,
            duties: entry.duties,
            earned: round(entry.earned)
        }));
    }
}

module.exports = new SupplyAnalytics();
