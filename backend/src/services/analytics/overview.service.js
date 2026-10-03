const Duty = require('../../models/Duty');
const Ticket = require('../../models/Ticket');
const revenueProvider = require('./revenue.provider');
const snapshotService = require('./snapshot.service');
const { ACTIVE_STATUSES: ACTIVE_TICKET_STATUSES } = require('../../utils/ticket.constants');
const { istDateKey, istDayStart, addDaysToKey } = require('../../utils/calendar.helper');
const { loadDuties, dutyFilter, wasFilled, wasWithdrawn, splitByPeriod } = require('./dutyData');
const { tile, ratio, sum, dutyHours, seriesFromRows, bucketsBetween, bucketKey } = require('../../utils/analytics.helper');

class OverviewAnalytics {
    async build(period, filters) {
        const [posted, completed, incomplete] = await Promise.all([
            loadDuties('createdAt', period.compareStart, period.end, filters, 'createdAt status assignedAt assignedTo hospital cancellation.cancelledBy'),
            loadDuties('completedAt', period.compareStart, period.end, filters, 'completedAt offeredRate totalPayment hospital assignedTo', { status: 'completed' }),
            loadDuties('incompleteAt', period.compareStart, period.end, filters, 'incompleteAt', { status: 'incomplete' })
        ]);

        const postedSplit = splitByPeriod(posted, d => d.createdAt, period);
        const completedSplit = splitByPeriod(completed, d => d.completedAt, period);
        const incompleteSplit = splitByPeriod(incomplete, d => d.incompleteAt, period);

        const measure = (postedRows, completedRows, incompleteRows) => {
            const filled = postedRows.filter(wasFilled).length;
            const withdrawn = postedRows.filter(wasWithdrawn).length;
            const gmv = sum(completedRows.map(d => d.totalPayment));
            return {
                completedHours: sum(completedRows.map(dutyHours)),
                posted: postedRows.length,
                fillRate: ratio(filled, postedRows.length - withdrawn),
                completionRate: ratio(completedRows.length, completedRows.length + incompleteRows.length),
                gmvCompleted: gmv,
                dutiesCompleted: completedRows.length,
                activeHospitals: new Set(postedRows.map(d => d.hospital?.toString())).size,
                activeStaff: new Set(completedRows.filter(d => d.assignedTo).map(d => d.assignedTo.toString())).size
            };
        };

        const cur = measure(postedSplit.current, completedSplit.current, incompleteSplit.current);
        const prev = measure(postedSplit.previous, completedSplit.previous, incompleteSplit.previous);

        const [revenueCur, revenuePrev, openTickets, snapshots, yearly] = await Promise.all([
            revenueProvider.getRevenue({ start: period.start, end: period.end, gmvCompleted: cur.gmvCompleted, dutiesCompleted: cur.dutiesCompleted }),
            revenueProvider.getRevenue({ start: period.compareStart, end: period.compareEnd, gmvCompleted: prev.gmvCompleted, dutiesCompleted: prev.dutiesCompleted }),
            Ticket.countDocuments({ status: { $in: ACTIVE_TICKET_STATUSES } }),
            snapshotService.getSnapshots(period.compareTo, period.to),
            this._lastTwelveMonths(filters)
        ]);

        const previousSnapshot = snapshots.find(s => s.date === period.compareTo);

        const tiles = [
            tile('completedHours', 'Completed duty-hours', cur.completedHours, prev.completedHours, 'hours', { northStar: true }),
            tile('dutiesPosted', 'Duties posted', cur.posted, prev.posted, 'count'),
            tile('fillRate', 'Fill rate', cur.fillRate, prev.fillRate, 'ratio'),
            tile('completionRate', 'Completion rate', cur.completionRate, prev.completionRate, 'ratio'),
            tile('gmvCompleted', 'Completed GMV', cur.gmvCompleted, prev.gmvCompleted, 'inr'),
            tile('platformRevenue', 'Platform revenue', revenueCur.netRevenue, revenuePrev.netRevenue, 'inr', {
                isProjected: revenueCur.isProjected,
                source: revenueCur.source
            }),
            tile('activeHospitals', 'Hospitals that posted', cur.activeHospitals, prev.activeHospitals, 'count'),
            tile('activeStaff', 'Staff who completed a duty', cur.activeStaff, prev.activeStaff, 'count'),
            tile('openTickets', 'Open support tickets', openTickets, previousSnapshot?.stocks?.ticketBacklog ?? null, 'count')
        ];

        const charts = [
            {
                key: 'activityTrend',
                type: 'line',
                title: 'Duties posted, filled and completed',
                series: this._activityTrend(postedSplit.current, completedSplit.current, period)
            },
            {
                key: 'gmvTrend',
                type: 'bar',
                title: 'Completed GMV',
                series: seriesFromRows(completedSplit.current, d => d.completedAt, period, { gmv: d => d.totalPayment, hours: dutyHours })
            },
            {
                key: 'lastTwelveMonths',
                type: 'line',
                title: 'Last 12 months',
                series: yearly
            },
            {
                key: 'platformStock',
                type: 'line',
                title: 'Platform size (daily snapshot)',
                series: snapshots.filter(s => s.date >= period.from).map(s => ({
                    bucket: s.date,
                    verifiedHospitals: s.stocks?.hospitals?.verified ?? null,
                    verifiedStaff: s.stocks?.staff?.verified ?? null,
                    availableStaff: s.stocks?.staff?.available ?? null,
                    openDuties: s.stocks?.openDuties ?? null,
                    ticketBacklog: s.stocks?.ticketBacklog ?? null
                }))
            }
        ];

        const dataNotes = [];
        if (revenueCur.isProjected) {
            dataNotes.push(`Platform revenue is projected at ${revenueCur.commissionPercent}% of completed GMV; no fee is charged yet.`);
        }
        if (!snapshots.length) {
            dataNotes.push('Platform size history starts from the first daily snapshot after analytics went live.');
        }

        return { tiles, charts, dataNotes };
    }



    _activityTrend(posted, completed, period) {
        const postedSeries = seriesFromRows(posted, d => d.createdAt, period, { posted: () => 1, filled: d => (wasFilled(d) ? 1 : 0) });
        const completedSeries = seriesFromRows(completed, d => d.completedAt, period, { completed: () => 1 });
        return postedSeries.map((row, i) => ({ ...row, completed: completedSeries[i].completed }));
    }



    // Monthly completed GMV and hours for the 12 months up to this month
    async _lastTwelveMonths(filters) {
        const todayKey = istDateKey(new Date());
        const fromKey = addDaysToKey(`${todayKey.slice(0, 7)}-01`, -335);
        const months = bucketsBetween(fromKey, todayKey, 'month').slice(-12);

        const base = await dutyFilter(filters);
        const rows = await Duty.find({
            ...base,
            status: 'completed',
            completedAt: { $gte: istDayStart(months[0]) }
        }).select('completedAt offeredRate totalPayment').lean();

        const byMonth = new Map(months.map(m => [m, { gmv: 0, hours: 0, duties: 0 }]));
        for (const duty of rows) {
            const bucket = byMonth.get(bucketKey(duty.completedAt, 'month'));
            if (!bucket) continue;
            bucket.gmv += duty.totalPayment || 0;
            bucket.hours += dutyHours(duty);
            bucket.duties++;
        }

        return months.map(m => ({
            bucket: m,
            gmv: Math.round(byMonth.get(m).gmv * 100) / 100,
            hours: Math.round(byMonth.get(m).hours * 100) / 100,
            duties: byMonth.get(m).duties
        }));
    }
}

module.exports = new OverviewAnalytics();
