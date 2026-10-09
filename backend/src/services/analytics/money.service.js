const Hospital = require('../../models/Hospital');
const revenueProvider = require('./revenue.provider');
const { loadDuties, wasFilled, wasWithdrawn, splitByPeriod } = require('./dutyData');
const {
    tile, ratio, round, sum, countBy, seriesFromRows, dutyHours, median
} = require('../../utils/analytics.helper');

const DAY_MS = 24 * 60 * 60 * 1000;

const EARNINGS_BANDS = [
    { key: 'under5k', label: 'Under ₹5,000', max: 5000 },
    { key: '5to15k', label: '₹5,000-15,000', max: 15000 },
    { key: '15to30k', label: '₹15,000-30,000', max: 30000 },
    { key: '30to60k', label: '₹30,000-60,000', max: 60000 },
    { key: 'over60k', label: 'Over ₹60,000', max: Infinity }
];

const PAY_LATER_AGE_BANDS = [
    { key: 'under7d', label: 'Under 7 days', max: 7 },
    { key: '7to30d', label: '7-30 days', max: 30 },
    { key: 'over30d', label: 'Over 30 days', max: Infinity }
];

// Hours-weighted average hourly rate
const averageRate = (list) => ratio(sum(list.map(d => d.totalPayment)), sum(list.map(dutyHours)), 2);

// Extra paid because the rate was raised after a late cancellation
const boostExtra = (duty) => (duty.autoRelist?.rateBoostApplied && duty.autoRelist.originalOfferedRate
    ? Math.max(0, (duty.offeredRate - duty.autoRelist.originalOfferedRate) * dutyHours(duty))
    : 0);

// Extra paid because the hospital raised the rate to fill the duty
const raiseExtra = (duty) => sum((duty.rateRaises || []).map(r =>
    Math.max(0, ((r.newRate || 0) - (r.previousRate || 0)) * dutyHours(duty))));

class MoneyAnalytics {
    async build(period, filters) {
        const [posted, completed] = await Promise.all([
            loadDuties('createdAt', period.compareStart, period.end, filters, 'createdAt status assignedTo totalPayment cancellation.cancelledBy'),
            loadDuties(
                'completedAt', period.compareStart, period.end, filters,
                'completedAt offeredRate totalPayment urgency staffRole hospital assignedTo isPaid paymentMethod autoRelist.rateBoostApplied autoRelist.originalOfferedRate rateRaises',
                { status: 'completed' }
            )
        ]);

        const postedSplit = splitByPeriod(posted, d => d.createdAt, period);
        const completedSplit = splitByPeriod(completed, d => d.completedAt, period);

        const measure = (postedRows, completedRows) => {
            const nonEmergency = completedRows.filter(d => d.urgency !== 'emergency');
            const emergency = completedRows.filter(d => d.urgency === 'emergency');
            const emergencyRate = averageRate(emergency);
            const normalRate = averageRate(nonEmergency);
            return {
                gmvPosted: sum(postedRows.filter(d => !wasWithdrawn(d)).map(d => d.totalPayment)),
                gmvFilled: sum(postedRows.filter(wasFilled).map(d => d.totalPayment)),
                gmvCompleted: sum(completedRows.map(d => d.totalPayment)),
                dutiesCompleted: completedRows.length,
                averageHourlyRate: averageRate(completedRows),
                averageDutyValue: completedRows.length ? sum(completedRows.map(d => d.totalPayment)) / completedRows.length : null,
                emergencyPremium: emergencyRate && normalRate ? round(emergencyRate / normalRate - 1, 4) : null,
                boostSpend: sum(completedRows.map(boostExtra)),
                raiseSpend: sum(completedRows.map(raiseExtra)),
                paidConfirmedShare: ratio(completedRows.filter(d => d.isPaid === true).length, completedRows.length),
                unconfirmedShare: ratio(completedRows.filter(d => d.isPaid === null || d.isPaid === undefined).length, completedRows.length)
            };
        };

        const cur = measure(postedSplit.current, completedSplit.current);
        const prev = measure(postedSplit.previous, completedSplit.previous);

        const [revenueCur, revenuePrev] = await Promise.all([
            revenueProvider.getRevenue({ start: period.start, end: period.end, gmvCompleted: cur.gmvCompleted, dutiesCompleted: cur.dutiesCompleted }),
            revenueProvider.getRevenue({ start: period.compareStart, end: period.compareEnd, gmvCompleted: prev.gmvCompleted, dutiesCompleted: prev.dutiesCompleted })
        ]);
        const revenueExtra = { isProjected: revenueCur.isProjected, source: revenueCur.source };

        const tiles = [
            tile('gmvPosted', 'GMV posted', cur.gmvPosted, prev.gmvPosted, 'inr'),
            tile('gmvFilled', 'GMV filled', cur.gmvFilled, prev.gmvFilled, 'inr'),
            tile('gmvCompleted', 'GMV completed', cur.gmvCompleted, prev.gmvCompleted, 'inr'),
            tile('averageHourlyRate', 'Average hourly rate', cur.averageHourlyRate, prev.averageHourlyRate, 'inr'),
            tile('averageDutyValue', 'Average completed duty value', cur.averageDutyValue, prev.averageDutyValue, 'inr'),
            tile('emergencyPremium', 'Emergency rate premium', cur.emergencyPremium, prev.emergencyPremium, 'ratio'),
            tile('boostSpend', 'Extra paid through rate boosts', cur.boostSpend, prev.boostSpend, 'inr'),
            tile('raiseSpend', 'Extra paid through rate raises', cur.raiseSpend, prev.raiseSpend, 'inr'),
            tile('paidConfirmedShare', 'Completed duties confirmed paid', cur.paidConfirmedShare, prev.paidConfirmedShare, 'ratio'),
            tile('commission', 'Platform commission', revenueCur.commission, revenuePrev.commission, 'inr', revenueExtra),
            tile('netRevenue', 'Net platform revenue', revenueCur.netRevenue, revenuePrev.netRevenue, 'inr', revenueExtra),
            tile('takeRate', 'Take rate', revenueCur.takeRate, revenuePrev.takeRate, 'ratio', revenueExtra),
            tile('revenuePerCompletedDuty', 'Revenue per completed duty', revenueCur.revenuePerCompletedDuty ?? null, revenuePrev.revenuePerCompletedDuty ?? null, 'inr', revenueExtra)
        ];

        const completedNow = completedSplit.current;
        const spendByHospital = await this._spendByHospital(completedNow, cur.gmvCompleted);

        const charts = [
            {
                key: 'gmvTrend',
                type: 'line',
                title: 'GMV posted and completed',
                series: this._gmvTrend(postedSplit.current, completedNow, period)
            },
            { key: 'rateByRole', type: 'table', title: 'Rates by role', rows: this._rateBy(completedNow, d => d.staffRole, 'staffRole') },
            { key: 'rateByUrgency', type: 'table', title: 'Rates by urgency', rows: this._rateBy(completedNow, d => d.urgency, 'urgency') },
            {
                key: 'paymentAttestation',
                type: 'donut',
                title: 'Payment status the hospital reported',
                rows: [
                    { key: 'paid', count: completedNow.filter(d => d.isPaid === true).length },
                    { key: 'notPaid', count: completedNow.filter(d => d.isPaid === false).length },
                    { key: 'unconfirmed', count: completedNow.filter(d => d.isPaid === null || d.isPaid === undefined).length }
                ]
            },
            { key: 'paymentMethods', type: 'donut', title: 'Payment method', rows: countBy(completedNow, d => d.paymentMethod) },
            { key: 'payLaterAgeing', type: 'bar', title: '"Will pay later" duties not yet confirmed paid, by age', rows: this._payLaterAgeing(completedNow) },
            { key: 'staffEarnings', type: 'bar', title: 'Staff earnings in the period', rows: this._earningsBands(completedNow) },
            { key: 'topHospitals', type: 'table', title: 'Top hospitals by completed GMV', rows: spendByHospital.top },
            {
                key: 'futureRevenue',
                type: 'table',
                title: 'Revenue KPIs that start once payments or subscriptions go live',
                rows: [
                    { key: 'mrr', label: 'Monthly recurring revenue', availability: 'needs_subscriptions' },
                    { key: 'arr', label: 'Annual recurring revenue', availability: 'needs_subscriptions' },
                    { key: 'activeSubscribers', label: 'Active subscribers', availability: 'needs_subscriptions' },
                    { key: 'arpa', label: 'Average revenue per account', availability: 'needs_subscriptions' },
                    { key: 'subscriptionChurn', label: 'Subscription churn', availability: 'needs_subscriptions' },
                    { key: 'paymentSuccessRate', label: 'Payment success rate', availability: revenueCur.payments ? 'available' : 'needs_payments', value: revenueCur.payments?.successRate ?? null },
                    { key: 'refundRate', label: 'Refunds', availability: revenueCur.refunds ? 'available' : 'needs_payments', value: revenueCur.refunds?.amount ?? null },
                    { key: 'payoutLag', label: 'Time from completion to staff payout', availability: 'needs_payments' },
                    { key: 'gstCollected', label: 'GST collected', availability: 'needs_payments' }
                ]
            }
        ];

        const dataNotes = [
            'GMV is the booked value of duties (hourly rate × scheduled hours), not money that moved through the platform.',
            '"Paid" is what the hospital reported when it closed the duty; there is no payment gateway yet.',
            `Top-10 hospitals account for ${spendByHospital.topShare === null ? '—' : `${Math.round(spendByHospital.topShare * 100)}%`} of completed GMV in this period.`
        ];
        if (revenueCur.isProjected) {
            dataNotes.push(`Revenue figures are projected at ${revenueCur.commissionPercent}% commission (Settings: analytics.projectedCommissionPercent).`);
        }

        return { tiles, charts, dataNotes };
    }



    _gmvTrend(posted, completed, period) {
        const postedSeries = seriesFromRows(posted.filter(d => !wasWithdrawn(d)), d => d.createdAt, period, { gmvPosted: d => d.totalPayment });
        const completedSeries = seriesFromRows(completed, d => d.completedAt, period, { gmvCompleted: d => d.totalPayment, boostSpend: boostExtra, raiseSpend: raiseExtra });
        return postedSeries.map((row, i) => ({ ...row, ...completedSeries[i] }));
    }



    _rateBy(rows, keyOf, label) {
        return countBy(rows, keyOf).map(({ key, count }) => {
            const list = rows.filter(d => keyOf(d) === key);
            return {
                [label]: key,
                duties: count,
                hours: round(sum(list.map(dutyHours))),
                gmv: round(sum(list.map(d => d.totalPayment))),
                averageHourlyRate: averageRate(list),
                medianHourlyRate: median(list.map(d => d.offeredRate))
            };
        });
    }



    _payLaterAgeing(rows) {
        const now = Date.now();
        const bands = PAY_LATER_AGE_BANDS.map(b => ({ ...b, count: 0, amount: 0 }));
        for (const duty of rows) {
            if (duty.paymentMethod !== 'will_pay_later' || duty.isPaid === true) continue;
            const ageDays = (now - new Date(duty.completedAt)) / DAY_MS;
            const band = bands.find(b => ageDays < b.max) || bands[bands.length - 1];
            band.count++;
            band.amount += duty.totalPayment || 0;
        }
        return bands.map(b => ({ band: b.key, label: b.label, count: b.count, amount: round(b.amount) }));
    }



    _earningsBands(rows) {
        const byStaff = new Map();
        for (const duty of rows) {
            if (!duty.assignedTo) continue;
            const id = duty.assignedTo.toString();
            byStaff.set(id, (byStaff.get(id) || 0) + (duty.totalPayment || 0));
        }
        const bands = EARNINGS_BANDS.map(b => ({ ...b, staff: 0 }));
        for (const total of byStaff.values()) {
            const band = bands.find(b => total < b.max) || bands[bands.length - 1];
            band.staff++;
        }
        return bands.map(b => ({ band: b.key, label: b.label, staff: b.staff }));
    }



    async _spendByHospital(rows, gmvTotal) {
        const byHospital = new Map();
        for (const duty of rows) {
            if (!duty.hospital) continue;
            const id = duty.hospital.toString();
            const entry = byHospital.get(id) || { gmv: 0, duties: 0 };
            entry.gmv += duty.totalPayment || 0;
            entry.duties++;
            byHospital.set(id, entry);
        }

        const ranked = [...byHospital.entries()].sort((a, b) => b[1].gmv - a[1].gmv).slice(0, 10);
        const hospitals = await Hospital.find({ _id: { $in: ranked.map(([id]) => id) } }).select('hospitalLegalName city').lean();
        const nameById = new Map(hospitals.map(h => [h._id.toString(), h]));

        const top = ranked.map(([id, entry]) => ({
            hospitalId: id,
            name: nameById.get(id)?.hospitalLegalName || '—',
            city: nameById.get(id)?.city || null,
            duties: entry.duties,
            gmv: round(entry.gmv),
            share: ratio(entry.gmv, gmvTotal)
        }));

        return { top, topShare: ratio(sum(ranked.map(([, e]) => e.gmv)), gmvTotal) };
    }
}

module.exports = new MoneyAnalytics();
