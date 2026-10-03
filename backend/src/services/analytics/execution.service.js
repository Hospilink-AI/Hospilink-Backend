const systemConfigService = require('../systemConfig.service');
const { loadDuties, wasFilled, splitByPeriod } = require('./dutyData');
const {
    tile, ratio, median, sum, countBy, seriesFromRows, scheduledStart, dutyHours
} = require('../../utils/analytics.helper');

const ON_TIME_GRACE_MINUTES = 10;

// Minutes before shift start a cancellation came in
const CANCELLATION_LEAD_BANDS = [
    { key: 'under1h', label: 'Under 1 hour', max: 60 },
    { key: '1to3h', label: '1-3 hours', max: 180 },
    { key: '3to12h', label: '3-12 hours', max: 720 },
    { key: '12to24h', label: '12-24 hours', max: 1440 },
    { key: 'over24h', label: 'Over 24 hours', max: Infinity }
];

const SELECT = [
    'date startTime status assignedTo startedAt enrouteAt completedAt incompleteAt pendingConfirmationAt',
    'startOtp.status startOtp.unlockedBy endOtp.status endOtp.unlockedBy statusHistory.manualOverride',
    'cancellation offeredRate totalPayment autoRelist.history'
].join(' ');

const otpLocked = (otp) => Boolean(otp && (otp.status === 'LOCKED' || otp.unlockedBy));

class ExecutionAnalytics {
    // Duties are counted by the day their shift is scheduled
    async build(period, filters) {
        const [rows, lateBandMinutes] = await Promise.all([
            loadDuties('date', period.compareStart, period.end, filters, SELECT),
            systemConfigService.getEffective('autoRelist.lateCancellationBandMinutes')
        ]);
        const { current, previous } = splitByPeriod(rows, d => d.date, period);

        const measure = (list) => {
            const completed = list.filter(d => d.status === 'completed');
            const incomplete = list.filter(d => d.status === 'incomplete');
            const started = list.filter(d => d.startedAt);
            const startDelays = started.map(d => (new Date(d.startedAt) - scheduledStart(d)) / 60000);
            const staffCancellations = this._staffCancellations(list);
            return {
                scheduled: list.length,
                completed: completed.length,
                completionRate: ratio(completed.length, completed.length + incomplete.length),
                noShowRate: ratio(incomplete.filter(d => !d.startedAt).length, completed.length + incomplete.length),
                onTimeStartRate: ratio(startDelays.filter(m => m <= ON_TIME_GRACE_MINUTES).length, startDelays.length),
                medianStartDelay: median(startDelays),
                enrouteUsage: ratio(started.filter(d => d.enrouteAt).length, started.length),
                hospitalCancellationRate: ratio(list.filter(d => d.status === 'cancelled' && d.cancellation?.cancelledBy === 'hospital').length, list.length),
                staffCancellationRate: ratio(staffCancellations.length, list.filter(wasFilled).length + staffCancellations.length),
                lateStaffCancellationShare: ratio(staffCancellations.filter(c => (c.minutesBeforeStart ?? Infinity) < lateBandMinutes).length, staffCancellations.length),
                otpLockRate: ratio(started.filter(d => otpLocked(d.startOtp) || otpLocked(d.endOtp)).length, started.length),
                adminOverrideRate: ratio(list.filter(d => (d.statusHistory || []).some(h => h.manualOverride)).length, list.length),
                confirmationDwell: median(completed
                    .filter(d => d.pendingConfirmationAt && d.completedAt)
                    .map(d => (new Date(d.completedAt) - new Date(d.pendingConfirmationAt)) / 60000)),
                bookedHoursCompleted: sum(completed.map(dutyHours))
            };
        };

        const cur = measure(current);
        const prev = measure(previous);

        const tiles = [
            tile('completionRate', 'Completion rate', cur.completionRate, prev.completionRate, 'ratio'),
            tile('onTimeStartRate', `Started within ${ON_TIME_GRACE_MINUTES} min of schedule`, cur.onTimeStartRate, prev.onTimeStartRate, 'ratio'),
            tile('medianStartDelay', 'Median start delay', cur.medianStartDelay, prev.medianStartDelay, 'minutes'),
            tile('noShowRate', 'Staff no-show rate', cur.noShowRate, prev.noShowRate, 'ratio'),
            tile('staffCancellationRate', 'Staff cancellation rate', cur.staffCancellationRate, prev.staffCancellationRate, 'ratio'),
            tile('lateStaffCancellationShare', `Staff cancellations under ${lateBandMinutes} min before start`, cur.lateStaffCancellationShare, prev.lateStaffCancellationShare, 'ratio'),
            tile('hospitalCancellationRate', 'Hospital cancellation rate', cur.hospitalCancellationRate, prev.hospitalCancellationRate, 'ratio'),
            tile('otpLockRate', 'Duties with an OTP lockout', cur.otpLockRate, prev.otpLockRate, 'ratio'),
            tile('adminOverrideRate', 'Duties needing an admin override', cur.adminOverrideRate, prev.adminOverrideRate, 'ratio'),
            tile('confirmationDwell', 'Median wait for hospital confirmation', cur.confirmationDwell, prev.confirmationDwell, 'minutes'),
            tile('enrouteUsage', 'Started duties that used "on my way"', cur.enrouteUsage, prev.enrouteUsage, 'ratio')
        ];

        const staffCancellations = this._staffCancellations(current);
        const hospitalCancellations = current.filter(d => d.status === 'cancelled' && d.cancellation?.cancelledBy === 'hospital');

        const charts = [
            {
                key: 'outcomes',
                type: 'stackedBar',
                title: 'Outcome of scheduled duties',
                series: seriesFromRows(current, d => d.date, period, {
                    completed: d => (d.status === 'completed' ? 1 : 0),
                    incomplete: d => (d.status === 'incomplete' ? 1 : 0),
                    expired: d => (d.status === 'expired' ? 1 : 0),
                    cancelled: d => (d.status === 'cancelled' ? 1 : 0),
                    inProgress: d => (['assigned', 'enroute', 'in-progress', 'pending-confirmation', 'available'].includes(d.status) ? 1 : 0)
                })
            },
            {
                key: 'staffCancellationReasons',
                type: 'donut',
                title: 'Why staff cancelled',
                rows: countBy(staffCancellations, c => c.reason)
            },
            {
                key: 'staffCancellationLeadTime',
                type: 'bar',
                title: 'How long before the shift staff cancelled',
                rows: this._leadBands(staffCancellations.map(c => c.minutesBeforeStart))
            },
            {
                key: 'hospitalCancellationReasons',
                type: 'donut',
                title: 'Why hospitals cancelled',
                rows: countBy(hospitalCancellations, d => d.cancellation?.reason)
            },
            {
                key: 'hospitalCancellationTiming',
                type: 'donut',
                title: 'Hospital cancellations before or after a staff member accepted',
                rows: [
                    { key: 'beforeFill', count: hospitalCancellations.filter(d => !d.assignedTo).length },
                    { key: 'afterFill', count: hospitalCancellations.filter(d => d.assignedTo).length }
                ]
            }
        ];

        return {
            tiles,
            charts,
            dataNotes: [
                'Duties are counted on the day their shift is scheduled.',
                'No-show means the duty ended incomplete without the start OTP ever being verified.'
            ]
        };
    }



    // Every staff cancellation recorded on these duties (the duty itself goes
    // back to available, so these only live in its relist history)
    _staffCancellations(list) {
        const result = [];
        for (const duty of list) {
            for (const entry of duty.autoRelist?.history || []) {
                if (entry.cancelledBy) result.push(entry);
            }
        }
        return result;
    }



    _leadBands(minutesList) {
        const bands = CANCELLATION_LEAD_BANDS.map(b => ({ band: b.key, label: b.label, max: b.max, count: 0 }));
        for (const minutes of minutesList) {
            if (minutes === null || minutes === undefined) continue;
            const band = bands.find(b => minutes < b.max) || bands[bands.length - 1];
            band.count++;
        }
        return bands.map(({ max, ...rest }) => rest);
    }
}

module.exports = new ExecutionAnalytics();
