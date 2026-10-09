const Duty = require('../../models/Duty');
const Hospital = require('../../models/Hospital');
const { buildCohorts, monthKey } = require('./cohorts');
const { splitByPeriod, wasFilled, wasWithdrawn } = require('./dutyData');
const { istDateKey, istDayStart, addDaysToKey } = require('../../utils/calendar.helper');
const { tile, ratio, median, countBy, seriesFromRows } = require('../../utils/analytics.helper');

const escapeRegex = require('../../utils/escapeRegex');
const DAY_MS = 24 * 60 * 60 * 1000;
const AT_RISK_QUIET_DAYS = 30;
const AT_RISK_LOOKBACK_DAYS = 90;

const hoursBetween = (from, to) => (new Date(to) - new Date(from)) / 3600000;

class DemandAnalytics {
    async build(period, filters) {
        const hospitalQuery = filters.city
            ? { city: { $regex: `^${escapeRegex(filters.city.trim())}$`, $options: 'i' } }
            : {};
        const allHospitals = await Hospital.find(hospitalQuery)
            .select('hospitalLegalName city state staffCount verificationStatus isSuspended isProfileComplete isDocumentsUploaded createdAt verifiedAt')
            .lean();
        const hospitalIds = allHospitals.map(h => h._id);
        const dutyScope = {
            hospital: { $in: hospitalIds },
            ...(filters.staffRole && { staffRole: filters.staffRole }),
            ...(filters.urgency && { urgency: filters.urgency })
        };

        const cohortStart = istDayStart(`${addDaysToKey(`${istDateKey(new Date()).slice(0, 7)}-01`, -335).slice(0, 7)}-01`);
        const lookbackStart = new Date(Math.min(period.compareStart.getTime(), period.end.getTime() - AT_RISK_LOOKBACK_DAYS * DAY_MS));

        const [firsts, recentPosts, cohortActivity] = await Promise.all([
            Duty.aggregate([
                { $match: { hospital: { $in: hospitalIds } } },
                {
                    $group: {
                        _id: '$hospital',
                        firstPost: { $min: '$createdAt' },
                        firstFill: { $min: '$assignedAt' }
                    }
                }
            ]),
            Duty.find({ ...dutyScope, createdAt: { $gte: lookbackStart, $lt: period.end } })
                .select('hospital createdAt status assignedTo cancellation.cancelledBy')
                .lean(),
            Duty.find({ hospital: { $in: hospitalIds }, createdAt: { $gte: cohortStart } })
                .select('hospital createdAt')
                .lean()
        ]);

        const firstByHospital = new Map(firsts.map(f => [f._id.toString(), f]));
        const signupSplit = splitByPeriod(allHospitals, h => h.createdAt, period);
        const verifiedSplit = splitByPeriod(allHospitals.filter(h => h.verifiedAt), h => h.verifiedAt, period);
        const postSplit = splitByPeriod(recentPosts, d => d.createdAt, period);

        const measure = (signups, verified, posts, start, end) => {
            const posting = new Set(posts.map(d => d.hospital.toString()));
            const firstPostsInPeriod = [...firstByHospital.entries()]
                .filter(([, f]) => f.firstPost >= start && f.firstPost < end);
            const firstFillsInPeriod = [...firstByHospital.entries()]
                .filter(([, f]) => f.firstFill && f.firstFill >= start && f.firstFill < end);
            const createdById = new Map(allHospitals.map(h => [h._id.toString(), h.createdAt]));
            return {
                signups: signups.length,
                signupsVerified: ratio(signups.filter(h => h.verificationStatus === 'verified').length, signups.length),
                verifiedCount: verified.length,
                medianTimeToVerify: median(verified.map(h => hoursBetween(h.createdAt, h.verifiedAt))),
                activeHospitals: posting.size,
                newPostingHospitals: firstPostsInPeriod.length,
                medianTimeToFirstPost: median(firstPostsInPeriod.map(([id, f]) => hoursBetween(createdById.get(id), f.firstPost))),
                medianTimeToFirstFill: median(firstFillsInPeriod.map(([id, f]) => hoursBetween(createdById.get(id), f.firstFill))),
                dutiesPerHospital: ratio(posts.length, posting.size, 2),
                hospitalCancellationRate: ratio(
                    posts.filter(d => d.status === 'cancelled' && d.cancellation?.cancelledBy === 'hospital').length,
                    posts.length
                ),
                postingIds: posting
            };
        };

        const cur = measure(signupSplit.current, verifiedSplit.current, postSplit.current, period.start, period.end);
        const prev = measure(signupSplit.previous, verifiedSplit.previous, postSplit.previous, period.compareStart, period.compareEnd);

        const repeatHospitals = [...prev.postingIds].filter(id => cur.postingIds.has(id)).length;
        const verifiedHospitals = allHospitals.filter(h => h.verificationStatus === 'verified' && !h.isSuspended);
        const activation = ratio(verifiedHospitals.filter(h => firstByHospital.has(h._id.toString())).length, verifiedHospitals.length);

        const tiles = [
            tile('hospitalSignups', 'Hospital signups', cur.signups, prev.signups, 'count'),
            tile('signupsVerified', 'Signups now verified', cur.signupsVerified, prev.signupsVerified, 'ratio'),
            tile('hospitalsVerified', 'Hospitals verified', cur.verifiedCount, prev.verifiedCount, 'count'),
            tile('hospitalTimeToVerify', 'Median signup to verification', cur.medianTimeToVerify, prev.medianTimeToVerify, 'hours'),
            tile('activation', 'Verified hospitals that have posted', activation, null, 'ratio'),
            tile('activeHospitals', 'Hospitals that posted', cur.activeHospitals, prev.activeHospitals, 'count'),
            tile('newPostingHospitals', 'Hospitals that posted their first duty', cur.newPostingHospitals, prev.newPostingHospitals, 'count'),
            tile('timeToFirstPost', 'Median signup to first post', cur.medianTimeToFirstPost, prev.medianTimeToFirstPost, 'hours'),
            tile('timeToFirstFill', 'Median signup to first filled duty', cur.medianTimeToFirstFill, prev.medianTimeToFirstFill, 'hours'),
            tile('repeatPosting', 'Posted last period and again this period', ratio(repeatHospitals, prev.postingIds.size), null, 'ratio'),
            tile('dutiesPerHospital', 'Duties per posting hospital', cur.dutiesPerHospital, prev.dutiesPerHospital, 'ratio'),
            tile('hospitalCancellationRate', 'Posted duties the hospital cancelled', cur.hospitalCancellationRate, prev.hospitalCancellationRate, 'ratio')
        ];

        const charts = [
            {
                key: 'signupTrend',
                type: 'line',
                title: 'Hospital signups',
                series: seriesFromRows(signupSplit.current, h => h.createdAt, period, {
                    signups: () => 1,
                    verified: h => (h.verificationStatus === 'verified' ? 1 : 0)
                })
            },
            {
                key: 'verificationFunnel',
                type: 'funnel',
                title: 'Signups in this period, by how far they got',
                stages: [
                    { key: 'signedUp', label: 'Signed up', value: signupSplit.current.length },
                    { key: 'profileComplete', label: 'Profile complete', value: signupSplit.current.filter(h => h.isProfileComplete).length },
                    { key: 'documentsUploaded', label: 'Documents uploaded', value: signupSplit.current.filter(h => h.isDocumentsUploaded).length },
                    { key: 'verified', label: 'Verified', value: signupSplit.current.filter(h => h.verificationStatus === 'verified').length },
                    { key: 'posted', label: 'Posted a duty', value: signupSplit.current.filter(h => firstByHospital.has(h._id.toString())).length }
                ]
            },
            {
                key: 'retentionCohorts',
                type: 'cohort',
                title: 'Hospitals still posting, by month of first post',
                ...buildCohorts(
                    new Map([...firstByHospital.entries()].map(([id, f]) => [id, f.firstPost])),
                    cohortActivity.map(d => ({ id: d.hospital, at: d.createdAt })),
                    monthKey(new Date())
                )
            },
            { key: 'topPosters', type: 'table', title: 'Hospitals posting the most', rows: this._topPosters(postSplit.current, allHospitals) },
            { key: 'atRisk', type: 'table', title: `Hospitals quiet for ${AT_RISK_QUIET_DAYS}+ days after posting before`, rows: this._atRisk(recentPosts, allHospitals, period) },
            { key: 'bySize', type: 'donut', title: 'Verified hospitals by staff size', rows: countBy(verifiedHospitals, h => h.staffCount) },
            { key: 'byCity', type: 'table', title: 'Verified hospitals by city', rows: countBy(verifiedHospitals, h => h.city?.trim(), 20) }
        ];

        return {
            tiles,
            charts,
            dataNotes: [
                'Time to verify only covers hospitals verified after verifiedAt started being recorded.',
                'Repeat posting compares hospitals that posted in the previous period with this one.'
            ]
        };
    }



    _topPosters(posts, hospitals) {
        const byId = new Map(hospitals.map(h => [h._id.toString(), h]));
        const counts = new Map();
        for (const duty of posts) {
            const id = duty.hospital.toString();
            const entry = counts.get(id) || { posted: 0, filled: 0, withdrawn: 0 };
            entry.posted++;
            if (wasFilled(duty)) entry.filled++;
            if (wasWithdrawn(duty)) entry.withdrawn++;
            counts.set(id, entry);
        }
        return [...counts.entries()]
            .sort((a, b) => b[1].posted - a[1].posted)
            .slice(0, 15)
            .map(([id, e]) => ({
                hospitalId: id,
                name: byId.get(id)?.hospitalLegalName || '—',
                city: byId.get(id)?.city || null,
                posted: e.posted,
                fillRate: ratio(e.filled, e.posted - e.withdrawn)
            }));
    }



    // Posted in the lookback window but nothing in the last 30 days of the period
    _atRisk(posts, hospitals, period) {
        const quietSince = new Date(period.end.getTime() - AT_RISK_QUIET_DAYS * DAY_MS);
        const lastPost = new Map();
        for (const duty of posts) {
            const id = duty.hospital.toString();
            if (!lastPost.has(id) || duty.createdAt > lastPost.get(id)) lastPost.set(id, duty.createdAt);
        }
        const byId = new Map(hospitals.map(h => [h._id.toString(), h]));
        return [...lastPost.entries()]
            .filter(([, at]) => at < quietSince)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25)
            .map(([id, at]) => ({
                hospitalId: id,
                name: byId.get(id)?.hospitalLegalName || '—',
                city: byId.get(id)?.city || null,
                lastPostedOn: istDateKey(at),
                daysQuiet: Math.floor((period.end - at) / DAY_MS)
            }));
    }
}

module.exports = new DemandAnalytics();
