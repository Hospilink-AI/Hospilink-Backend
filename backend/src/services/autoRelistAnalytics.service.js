const Duty = require('../models/Duty');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const Ticket = require('../models/Ticket');
const AutoRelistDailyRollup = require('../models/AutoRelistDailyRollup');
const { NotFoundError, ForbiddenError } = require('../middleware/error.middleware');
const systemConfigService = require('./systemConfig.service');

const REFILLED_STATUSES = ['assigned', 'enroute', 'in-progress', 'pending-confirmation', 'completed'];

function daysAgo(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function median(numbers) {
    if (numbers.length === 0) return null;
    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function emptyDayStats() {
    return {
        relistsCount: 0, refilledCount: 0,
        boostedCount: 0, boostedFilledCount: 0,
        unboostedCount: 0, unboostedFilledCount: 0,
        extraPaid: 0, byReason: {}
    };
}

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

class AutoRelistAnalyticsService {
    // Super Admin dashboard tiles, minus boost spend (separate
    // method, separate capability) and the pair/hospital watchlists (not
    // yet built — correlating "who accepted after X cancelled" and a
    // platform-average relist rate both need more design than a first pass
    // warrants; flagged rather than shipped half-right).
    async getOperationalTiles() {
        const [relistsToday, relists7d, relists30d] = await Promise.all([
            Duty.countDocuments({ 'autoRelist.history.timestamp': { $gte: daysAgo(1) } }),
            Duty.countDocuments({ 'autoRelist.history.timestamp': { $gte: daysAgo(7) } }),
            Duty.countDocuments({ 'autoRelist.history.timestamp': { $gte: daysAgo(30) } })
        ]);

        const relistedDuties = await Duty.find({ 'autoRelist.relistCount': { $gt: 0 } })
            .select('status offeredRate autoRelist')
            .lean();

        let boostedFilled = 0, boostedTotal = 0, unboostedFilled = 0, unboostedTotal = 0;
        let featureOnFilled = 0, featureOnTotal = 0, featureOffFilled = 0, featureOffTotal = 0;
        const refillMinutes = [];
        const byReason = {};

        for (const duty of relistedDuties) {
            const relist = duty.autoRelist || {};
            const wasRefilled = REFILLED_STATUSES.includes(duty.status);

            if (relist.rateBoostApplied) {
                boostedTotal += 1;
                if (wasRefilled) boostedFilled += 1;
            } else {
                unboostedTotal += 1;
                if (wasRefilled) unboostedFilled += 1;
            }

            // "Feature off" here means this specific duty opted out
            // (autoRelist.enabled === false) yet still went through a
            // staff cancellation — the control group spec §07 asks for.
            if (relist.enabled === false) {
                featureOffTotal += 1;
                if (wasRefilled) featureOffFilled += 1;
            } else {
                featureOnTotal += 1;
                if (wasRefilled) featureOnFilled += 1;
            }

            const history = relist.history || [];
            for (const entry of history) {
                if (!entry.reason) continue;
                byReason[entry.reason] = (byReason[entry.reason] || 0) + 1;
            }

            // Time-to-refill approximation: last relist event to the
            // duty's current assignedAt. Accurate for single-relist duties;
            // for duties relisted more than once this measures "time from
            // the MOST RECENT cancellation to the eventual fill," which is
            // the number that actually matters operationally, even though
            // it isn't a per-relist-event breakdown.
            if (wasRefilled && duty.assignedAt && history.length > 0) {
                const lastEntry = history[history.length - 1];
                const minutes = (new Date(duty.assignedAt) - new Date(lastEntry.timestamp)) / (60 * 1000);
                if (minutes > 0) refillMinutes.push(minutes);
            }
        }

        const rate = (filled, total) => (total > 0 ? filled / total : null);

        return {
            relists: { today: relistsToday, last7Days: relists7d, last30Days: relists30d },
            refillRate: {
                boosted: { filled: boostedFilled, total: boostedTotal, rate: rate(boostedFilled, boostedTotal) },
                unboosted: { filled: unboostedFilled, total: unboostedTotal, rate: rate(unboostedFilled, unboostedTotal) }
            },
            controlComparison: {
                featureOn: { filled: featureOnFilled, total: featureOnTotal, rate: rate(featureOnFilled, featureOnTotal) },
                featureOff: { filled: featureOffFilled, total: featureOffTotal, rate: rate(featureOffFilled, featureOffTotal) }
            },
            medianTimeToRefillMinutes: median(refillMinutes),
            byReason
        };
    }

    // Computes one calendar day's stats (platform-wide + per hospital),
    // scoped to autoRelist.history entries that happened on that day.
    // Pure computation, no writes — used both by computeDailyRollup
    // (persists it) and getRelistTrend (today's point, never persisted;
    // "read the current day live").
    //
    // A duty relisted more than once only gets ONE fill/no-fill/extra-paid
    // outcome ever, so that outcome is attributed to whichever day holds
    // the duty's LAST relist event — the same simplification already used
    // in getOperationalTiles' time-to-refill approximation.
    async _computeDayStats(dayStart) {
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const duties = await Duty.find({
            'autoRelist.history.timestamp': { $gte: dayStart, $lt: dayEnd }
        }).select('hospital status offeredRate autoRelist').lean();

        const platform = emptyDayStats();
        const byHospital = new Map();

        for (const duty of duties) {
            const relist = duty.autoRelist || {};
            const history = relist.history || [];
            const lastEntry = history[history.length - 1];
            const wasRefilled = REFILLED_STATUSES.includes(duty.status);

            const hospitalId = duty.hospital?.toString() || null;
            if (hospitalId && !byHospital.has(hospitalId)) {
                byHospital.set(hospitalId, emptyDayStats());
            }
            const hStats = hospitalId ? byHospital.get(hospitalId) : null;

            for (const entry of history) {
                const t = new Date(entry.timestamp);
                if (t < dayStart || t >= dayEnd) continue;

                platform.relistsCount += 1;
                if (hStats) hStats.relistsCount += 1;

                const wasBoostedThisEvent = entry.rateAfter > entry.rateBefore;
                const bucket = wasBoostedThisEvent ? 'boostedCount' : 'unboostedCount';
                platform[bucket] += 1;
                if (hStats) hStats[bucket] += 1;

                if (entry.reason) {
                    platform.byReason[entry.reason] = (platform.byReason[entry.reason] || 0) + 1;
                    if (hStats) hStats.byReason[entry.reason] = (hStats.byReason[entry.reason] || 0) + 1;
                }

                const isLastEntryEver = lastEntry && new Date(lastEntry.timestamp).getTime() === t.getTime();
                if (isLastEntryEver && wasRefilled) {
                    platform.refilledCount += 1;
                    if (hStats) hStats.refilledCount += 1;

                    const filledBucket = wasBoostedThisEvent ? 'boostedFilledCount' : 'unboostedFilledCount';
                    platform[filledBucket] += 1;
                    if (hStats) hStats[filledBucket] += 1;

                    if (wasBoostedThisEvent && relist.originalOfferedRate != null) {
                        const extra = duty.offeredRate - relist.originalOfferedRate;
                        platform.extraPaid += extra;
                        if (hStats) hStats.extraPaid += extra;
                    }
                }
            }
        }

        return { platform, byHospital };
    }

    // Nightly rollup write (spec §07/§09) — called once a day from
    // utils/cronJobs.js for the just-completed calendar day. Upserts so a
    // re-run for the same day (e.g. after a crash) corrects rather than
    // duplicates.
    async computeDailyRollup(forDate) {
        const dayStart = startOfDay(forDate);
        const { platform, byHospital } = await this._computeDayStats(dayStart);

        const ops = [{
            updateOne: {
                filter: { scope: 'platform', hospital: null, date: dayStart },
                update: { $set: { ...platform, scope: 'platform', hospital: null, date: dayStart } },
                upsert: true
            }
        }];

        for (const [hospitalId, stats] of byHospital) {
            ops.push({
                updateOne: {
                    filter: { scope: 'hospital', hospital: hospitalId, date: dayStart },
                    update: { $set: { ...stats, scope: 'hospital', hospital: hospitalId, date: dayStart } },
                    upsert: true
                }
            });
        }

        await AutoRelistDailyRollup.bulkWrite(ops);
        return { hospitalsWritten: byHospital.size };
    }

    // Platform-wide day-by-day series for the "Relists ... with the trend"
    // tile. Reads persisted rollups for every day except today, which is
    // computed live and appended — spec §07's "store a daily document...
    // and read the current day live," applied literally.
    async getRelistTrend(days = 30) {
        const todayStart = startOfDay(new Date());
        const rangeStart = new Date(todayStart);
        rangeStart.setDate(rangeStart.getDate() - (days - 1));

        const rollups = await AutoRelistDailyRollup.find({
            scope: 'platform',
            date: { $gte: rangeStart, $lt: todayStart }
        }).sort({ date: 1 }).lean();

        const series = rollups.map(r => ({
            date: r.date.toISOString().slice(0, 10),
            relistsCount: r.relistsCount,
            refilledCount: r.refilledCount,
            extraPaid: r.extraPaid
        }));

        const { platform: todayStats } = await this._computeDayStats(todayStart);
        series.push({
            date: todayStart.toISOString().slice(0, 10),
            relistsCount: todayStats.relistsCount,
            refilledCount: todayStats.refilledCount,
            extraPaid: todayStats.extraPaid
        });

        return series;
    }



    // Super Admin only (platform total + per-hospital) — separate method
    // and separate route from getOperationalTiles so the capability gate
    // is enforced server-side, not by hiding a UI component (spec §08).
    async getBoostSpend() {
        const duties = await Duty.find({ 'autoRelist.rateBoostApplied': true })
            .select('hospital offeredRate status autoRelist')
            .populate('hospital', 'hospitalLegalName')
            .lean();

        let platformTotal = 0;
        const perHospital = new Map();

        for (const duty of duties) {
            if (!REFILLED_STATUSES.includes(duty.status)) continue; // spec §06.06 — never charged for an unused rise
            const relist = duty.autoRelist || {};
            if (relist.originalOfferedRate == null) continue;

            const extra = duty.offeredRate - relist.originalOfferedRate;
            platformTotal += extra;

            const hospitalId = duty.hospital?._id?.toString() || 'unknown';
            const existing = perHospital.get(hospitalId) || {
                hospitalId,
                hospitalName: duty.hospital?.hospitalLegalName || 'Unknown',
                extraPaid: 0
            };
            existing.extraPaid += extra;
            perHospital.set(hospitalId, existing);
        }

        return {
            platformTotal,
            perHospital: [...perHospital.values()].sort((a, b) => b.extraPaid - a.extraPaid)
        };
    }

    // Work queue, not a statistic (spec §07) — duties that hit the cap and
    // are still sitting open, each one needing a human.
    async getCapReachedQueue() {
        const relistCap = await systemConfigService.getEffective('autoRelist.relistCap');
        const duties = await Duty.find({
            status: 'available',
            'autoRelist.relistCount': { $gte: relistCap }
        })
            .select('staffRole date startTime endTime urgency offeredRate autoRelist hospital')
            .populate('hospital', 'hospitalLegalName')
            .sort({ date: 1, startTime: 1 })
            .lean();

        return duties.map(duty => ({
            dutyId: duty._id,
            hospitalName: duty.hospital?.hospitalLegalName || 'Unknown',
            staffRole: duty.staffRole,
            date: duty.date,
            startTime: duty.startTime,
            endTime: duty.endTime,
            urgency: duty.urgency,
            rate: duty.offeredRate,
            relistCount: duty.autoRelist.relistCount
        }));
    }

    // Gaming signal (spec §07) — staff cancelling inside the late band more
    // than the threshold within the window. Never returned to the staff
    // member themselves; this is an Operations/Super Admin-only view.
    async getStaffWatchlist() {
        const cfg = await systemConfigService.getManyEffective([
            'autoRelist.staffWatchlistWindowDays',
            'autoRelist.lateCancellationBandMinutes',
            'autoRelist.staffWatchlistThresholdCount'
        ]);
        const windowDays = cfg['autoRelist.staffWatchlistWindowDays'];
        const cutoff = daysAgo(windowDays);

        const results = await Duty.aggregate([
            { $unwind: '$autoRelist.history' },
            {
                $match: {
                    'autoRelist.history.timestamp': { $gte: cutoff },
                    'autoRelist.history.minutesBeforeStart': { $lt: cfg['autoRelist.lateCancellationBandMinutes'] }
                }
            },
            { $group: { _id: '$autoRelist.history.cancelledBy', count: { $sum: 1 } } },
            { $match: { count: { $gt: cfg['autoRelist.staffWatchlistThresholdCount'] } } },
            { $sort: { count: -1 } }
        ]);

        if (results.length === 0) return [];

        const staffIds = results.map(r => r._id);
        const staffDocs = await MedicalStaff.find({ _id: { $in: staffIds } })
            .select('fullName jobRole')
            .lean();
        const staffById = new Map(staffDocs.map(s => [s._id.toString(), s]));

        return results.map(r => ({
            medicalStaffId: r._id,
            fullName: staffById.get(r._id.toString())?.fullName || 'Unknown',
            jobRole: staffById.get(r._id.toString())?.jobRole || null,
            lateCancellationCount: r.count,
            windowDays
        }));
    }

    // The exploit the exclusion rule doesn't catch (spec §07): two staff
    // taking turns cancelling for each other into a boosted rate. Relies on
    // acceptDuty()'s backfill of autoRelist.history[].acceptedBy — entries
    // written before that existed have acceptedBy: null and are correctly
    // invisible here (there is no backfill migration for historical data;
    // this only sees pairs formed going forward).
    async getPairWatchlist() {
        const pairThreshold = await systemConfigService.getEffective('autoRelist.pairWatchlistThresholdCount');
        const results = await Duty.aggregate([
            { $unwind: '$autoRelist.history' },
            { $match: { 'autoRelist.history.acceptedBy': { $ne: null } } },
            {
                $group: {
                    _id: {
                        hospital: '$hospital',
                        cancelledBy: '$autoRelist.history.cancelledBy',
                        acceptedBy: '$autoRelist.history.acceptedBy'
                    },
                    count: { $sum: 1 }
                }
            },
            { $match: { count: { $gte: pairThreshold } } },
            { $sort: { count: -1 } }
        ]);

        if (results.length === 0) return [];

        const staffIds = new Set();
        const hospitalIds = new Set();
        for (const r of results) {
            staffIds.add(r._id.cancelledBy.toString());
            staffIds.add(r._id.acceptedBy.toString());
            hospitalIds.add(r._id.hospital.toString());
        }

        const [staffDocs, hospitalDocs] = await Promise.all([
            MedicalStaff.find({ _id: { $in: [...staffIds] } }).select('fullName').lean(),
            Hospital.find({ _id: { $in: [...hospitalIds] } }).select('hospitalLegalName').lean()
        ]);
        const staffNameById = new Map(staffDocs.map(s => [s._id.toString(), s.fullName]));
        const hospitalNameById = new Map(hospitalDocs.map(h => [h._id.toString(), h.hospitalLegalName]));

        return results.map(r => ({
            hospitalId: r._id.hospital,
            hospitalName: hospitalNameById.get(r._id.hospital.toString()) || 'Unknown',
            cancelledByStaffId: r._id.cancelledBy,
            cancelledByName: staffNameById.get(r._id.cancelledBy.toString()) || 'Unknown',
            acceptedByStaffId: r._id.acceptedBy,
            acceptedByName: staffNameById.get(r._id.acceptedBy.toString()) || 'Unknown',
            recurrenceCount: r.count
        }));
    }

    // Hospitals whose duties get relisted far above the platform average
    // (spec §07) — usually a rate set too low or a misleading duty
    // description. Rate is relist-events-per-duty-created in the trailing
    // 30 days, not a raw count, so hospital size doesn't skew it. Hospitals
    // with fewer than 5 duties in the window are excluded — too little
    // volume for a "rate" to mean anything.
    async getHospitalWatchlist() {
        const hospitalMultiplier = await systemConfigService.getEffective('autoRelist.hospitalWatchlistMultiplier');
        const cutoff = daysAgo(30);
        const MIN_DUTIES_FOR_SIGNAL = 5;

        const [relistCounts, dutyCounts] = await Promise.all([
            Duty.aggregate([
                { $unwind: '$autoRelist.history' },
                { $match: { 'autoRelist.history.timestamp': { $gte: cutoff } } },
                { $group: { _id: '$hospital', relists: { $sum: 1 } } }
            ]),
            Duty.aggregate([
                { $match: { createdAt: { $gte: cutoff } } },
                { $group: { _id: '$hospital', total: { $sum: 1 } } }
            ])
        ]);

        const relistByHospital = new Map(relistCounts.map(r => [r._id.toString(), r.relists]));
        const rates = dutyCounts
            .filter(d => d.total >= MIN_DUTIES_FOR_SIGNAL)
            .map(d => {
                const relists = relistByHospital.get(d._id.toString()) || 0;
                return { hospitalId: d._id, relists, totalDuties: d.total, rate: relists / d.total };
            });

        if (rates.length === 0) return [];

        const platformAverage = rates.reduce((sum, r) => sum + r.rate, 0) / rates.length;
        if (platformAverage === 0) return [];

        const flagged = rates
            .filter(r => r.rate > hospitalMultiplier * platformAverage)
            .sort((a, b) => b.rate - a.rate);

        if (flagged.length === 0) return [];

        const hospitalDocs = await Hospital.find({ _id: { $in: flagged.map(r => r.hospitalId) } })
            .select('hospitalLegalName')
            .lean();
        const nameById = new Map(hospitalDocs.map(h => [h._id.toString(), h.hospitalLegalName]));

        return flagged.map(r => ({
            hospitalId: r.hospitalId,
            hospitalName: nameById.get(r.hospitalId.toString()) || 'Unknown',
            relists: r.relists,
            totalDuties: r.totalDuties,
            relistRate: r.rate,
            platformAverageRate: platformAverage
        }));
    }

    // Relist history for one duty. Super Admin / Ops get it unconditionally;
    // Tech Support only when it's reached from an open ticket about that
    // specific duty (spec §07/§09's "Yes, from inside a ticket only") —
    // resolved and verified here rather than trusted from the caller.
    async getDutyRelistHistory(dutyId, adminSubRole, ticketId) {
        if (adminSubRole === 'tech_support') {
            if (!ticketId) {
                throw new ForbiddenError('Relist history is only visible to Tech Support from within an open ticket about this duty.');
            }

            const ticket = await Ticket.findById(ticketId).select('subjectType subjectId status').lean();
            const isOpenTicketAboutThisDuty = ticket &&
                ticket.subjectType === 'DUTY' &&
                ticket.subjectId?.toString() === dutyId.toString() &&
                !['WITHDRAWN', 'DUPLICATE', 'AUTO_CLOSED', 'CLOSED'].includes(ticket.status);

            if (!isOpenTicketAboutThisDuty) {
                throw new ForbiddenError('Relist history is only visible to Tech Support from within an open ticket about this duty.');
            }
        }

        const duty = await Duty.findById(dutyId).select('staffRole autoRelist').lean();
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        const staffIds = (duty.autoRelist?.history || []).map(h => h.cancelledBy).filter(Boolean);
        const staffDocs = staffIds.length
            ? await MedicalStaff.find({ _id: { $in: staffIds } }).select('fullName').lean()
            : [];
        const nameById = new Map(staffDocs.map(s => [s._id.toString(), s.fullName]));

        return {
            dutyId,
            staffRole: duty.staffRole,
            relistCount: duty.autoRelist?.relistCount || 0,
            rateBoostApplied: !!duty.autoRelist?.rateBoostApplied,
            history: (duty.autoRelist?.history || []).map(h => ({
                timestamp: h.timestamp,
                cancelledByName: nameById.get(h.cancelledBy?.toString()) || 'Unknown',
                reason: h.reason,
                reasonText: h.reasonText,
                minutesBeforeStart: h.minutesBeforeStart,
                urgencyBefore: h.urgencyBefore,
                urgencyAfter: h.urgencyAfter,
                rateBefore: h.rateBefore,
                rateAfter: h.rateAfter
            }))
        };
    }
}

module.exports = new AutoRelistAnalyticsService();
