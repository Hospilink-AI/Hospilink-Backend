const Duty = require('../../models/Duty');
const MedicalStaff = require('../../models/MedicalStaff');
const { loadDuties, dutyFilter, wasFilled, wasWithdrawn, splitByPeriod } = require('./dutyData');
const {
    tile, ratio, median, percentile, sum, countBy, seriesFromRows, scheduledStart
} = require('../../utils/analytics.helper');

const URGENCIES = ['low', 'medium', 'high', 'emergency'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Hours between posting and shift start
const LEAD_TIME_BANDS = [
    { key: 'under2h', label: 'Under 2 hours', max: 2 },
    { key: '2to6h', label: '2-6 hours', max: 6 },
    { key: '6to24h', label: '6-24 hours', max: 24 },
    { key: '1to3d', label: '1-3 days', max: 72 },
    { key: '3to7d', label: '3-7 days', max: 168 },
    { key: 'over7d', label: 'Over 7 days', max: Infinity }
];

const minutesToFill = (duty) => (duty.assignedAt ? (new Date(duty.assignedAt) - new Date(duty.createdAt)) / 60000 : null);

class MarketplaceAnalytics {
    async build(period, filters) {
        const posted = await loadDuties(
            'createdAt', period.compareStart, period.end, filters,
            '+viewedBy createdAt date startTime status assignedAt assignedTo urgency staffRole hospital notifiedCount cancellation.cancelledBy autoRelist.relistCount'
        );
        const { current, previous } = splitByPeriod(posted, d => d.createdAt, period);

        const measure = (rows) => {
            const filled = rows.filter(wasFilled);
            const fillTimes = filled.map(minutesToFill).filter(m => m !== null && m >= 0);
            return {
                posted: rows.length,
                filled: filled.length,
                fillRate: ratio(filled.length, rows.length - rows.filter(wasWithdrawn).length),
                expiredRate: ratio(rows.filter(d => d.status === 'expired').length, rows.length),
                medianTimeToFill: median(fillTimes),
                p90TimeToFill: percentile(fillTimes, 0.9),
                emergencyFillRate: ratio(
                    rows.filter(d => d.urgency === 'emergency' && wasFilled(d)).length,
                    rows.filter(d => d.urgency === 'emergency' && !wasWithdrawn(d)).length
                ),
                relistedShare: ratio(rows.filter(d => (d.autoRelist?.relistCount || 0) > 0).length, rows.length)
            };
        };

        const cur = measure(current);
        const prev = measure(previous);

        const tiles = [
            tile('dutiesPosted', 'Duties posted', cur.posted, prev.posted, 'count'),
            tile('fillRate', 'Fill rate', cur.fillRate, prev.fillRate, 'ratio'),
            tile('medianTimeToFill', 'Median time to fill', cur.medianTimeToFill, prev.medianTimeToFill, 'minutes'),
            tile('p90TimeToFill', 'Time to fill (90th percentile)', cur.p90TimeToFill, prev.p90TimeToFill, 'minutes'),
            tile('expiredRate', 'Expired unfilled', cur.expiredRate, prev.expiredRate, 'ratio'),
            tile('emergencyFillRate', 'Emergency fill rate', cur.emergencyFillRate, prev.emergencyFillRate, 'ratio'),
            tile('relistedShare', 'Duties relisted after a cancellation', cur.relistedShare, prev.relistedShare, 'ratio')
        ];

        const liquidity = await this._liquidity(filters);

        const charts = [
            {
                key: 'postedVsFilled',
                type: 'line',
                title: 'Posted, filled and expired',
                series: seriesFromRows(current, d => d.createdAt, period, {
                    posted: () => 1,
                    filled: d => (wasFilled(d) ? 1 : 0),
                    expired: d => (d.status === 'expired' ? 1 : 0)
                })
            },
            { key: 'byUrgency', type: 'table', title: 'Fill by urgency', rows: this._byUrgency(current) },
            { key: 'byRole', type: 'table', title: 'Fill by role', rows: this._byRole(current) },
            { key: 'offerFunnel', type: 'funnel', title: 'Notified, viewed, accepted', ...this._offerFunnel(current) },
            { key: 'leadTime', type: 'bar', title: 'Time from posting to shift start', rows: this._leadTime(current) },
            { key: 'demandHeat', type: 'heatmap', title: 'When duties are posted (IST)', ...this._demandHeat(current) },
            { key: 'liquidity', type: 'table', title: 'Open duties against available staff, by role', rows: liquidity }
        ];

        return {
            tiles,
            charts,
            dataNotes: [
                'Fill rate leaves out duties the hospital withdrew before anyone accepted.',
                'Notified and viewed counts exist only for duties posted after the duty calendar release.'
            ]
        };
    }



    _byUrgency(rows) {
        return URGENCIES.map(urgency => {
            const list = rows.filter(d => d.urgency === urgency);
            const filled = list.filter(wasFilled);
            return {
                urgency,
                posted: list.length,
                filled: filled.length,
                fillRate: ratio(filled.length, list.length - list.filter(wasWithdrawn).length),
                medianTimeToFill: median(filled.map(minutesToFill).filter(m => m !== null && m >= 0))
            };
        });
    }



    _byRole(rows) {
        return countBy(rows, d => d.staffRole).map(({ key }) => {
            const list = rows.filter(d => d.staffRole === key);
            const filled = list.filter(wasFilled);
            return {
                staffRole: key,
                posted: list.length,
                filled: filled.length,
                fillRate: ratio(filled.length, list.length - list.filter(wasWithdrawn).length),
                medianTimeToFill: median(filled.map(minutesToFill).filter(m => m !== null && m >= 0))
            };
        });
    }



    _offerFunnel(rows) {
        const tracked = rows.filter(d => typeof d.notifiedCount === 'number');
        return {
            dutiesTracked: tracked.length,
            stages: [
                { key: 'notified', label: 'Staff notified', value: sum(tracked.map(d => d.notifiedCount)) },
                { key: 'viewed', label: 'Staff who opened the duty', value: sum(tracked.map(d => (d.viewedBy || []).length)) },
                { key: 'accepted', label: 'Duties accepted', value: tracked.filter(wasFilled).length }
            ]
        };
    }



    _leadTime(rows) {
        const bands = LEAD_TIME_BANDS.map(b => ({ ...b, posted: 0, filled: 0, withdrawn: 0 }));
        for (const duty of rows) {
            const hours = (scheduledStart(duty) - new Date(duty.createdAt)) / 3600000;
            const band = bands.find(b => hours < b.max) || bands[bands.length - 1];
            band.posted++;
            if (wasFilled(duty)) band.filled++;
            if (wasWithdrawn(duty)) band.withdrawn++;
        }
        return bands.map(b => ({
            band: b.key,
            label: b.label,
            posted: b.posted,
            filled: b.filled,
            fillRate: ratio(b.filled, b.posted - b.withdrawn)
        }));
    }



    _demandHeat(rows) {
        const cells = WEEKDAYS.map(() => new Array(24).fill(0));
        for (const duty of rows) {
            const ist = new Date(new Date(duty.createdAt).getTime() + IST_OFFSET_MS);
            cells[(ist.getUTCDay() + 6) % 7][ist.getUTCHours()]++;
        }
        return { xLabels: [...Array(24).keys()].map(h => `${String(h).padStart(2, '0')}:00`), yLabels: WEEKDAYS, cells };
    }



    // Right now: open future duties per role against verified, available staff
    async _liquidity(filters) {
        const base = await dutyFilter(filters);
        const now = new Date();
        const [openDuties, availableStaff] = await Promise.all([
            Duty.find({ ...base, status: 'available', date: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } })
                .select('date startTime staffRole')
                .lean(),
            MedicalStaff.aggregate([
                { $match: { verificationStatus: 'verified', isAvailable: true, isSuspended: { $ne: true } } },
                { $group: { _id: { $toLower: '$jobRole' }, count: { $sum: 1 } } }
            ])
        ]);

        const staffByRole = new Map(availableStaff.map(r => [r._id, r.count]));
        const upcoming = openDuties.filter(d => scheduledStart(d) > now);

        return countBy(upcoming, d => d.staffRole).map(({ key, count }) => {
            const staff = staffByRole.get(String(key).toLowerCase()) || 0;
            return { staffRole: key, openDuties: count, availableStaff: staff, dutiesPerAvailableStaff: ratio(count, staff, 2) };
        });
    }
}

module.exports = new MarketplaceAnalytics();
