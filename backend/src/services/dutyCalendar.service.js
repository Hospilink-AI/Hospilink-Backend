const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const cacheService = require('./cache.service');
const systemConfigService = require('./systemConfig.service');
const locationBasedStaffService = require('./locationBasedStaff.service');
const ratingAlgorithmService = require('./ratingAlgorithm.service');
const s3Service = require('./s3.service');
const logger = require('../utils/logger');
const { NotFoundError, ForbiddenError } = require('../middleware/error.middleware');
const {
    istDateKey,
    istDayRange,
    addDaysToKey,
    hasDutyStarted,
    overnightContinuationKey
} = require('../utils/calendar.helper');

const FILLED_STATUSES = ['assigned', 'enroute', 'in-progress', 'pending-confirmation', 'completed', 'incomplete'];
const ACTIVE_STATUSES = ['enroute', 'in-progress', 'pending-confirmation'];

// Same 50km the open-duties feed ends on. The feed measures by road, the
// calendar can't call Maps, so it measures in a straight line.
const OPEN_DUTY_RADIUS_KM = 50;
const URGENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const CALENDAR_SETTING_KEYS = [
    'calendar.weekStart',
    'calendar.prefetchPeriods',
    'calendar.countsCacheSeconds',
    'calendar.bookingHorizonDays',
    'calendar.historyDays'
];

class DutyCalendarService {
    async getSettings() {
        const cfg = await systemConfigService.getManyEffective(CALENDAR_SETTING_KEYS);
        return {
            weekStart: cfg['calendar.weekStart'],
            prefetchPeriods: cfg['calendar.prefetchPeriods'],
            countsCacheSeconds: cfg['calendar.countsCacheSeconds'],
            bookingHorizonDays: cfg['calendar.bookingHorizonDays'],
            historyDays: cfg['calendar.historyDays']
        };
    }



    // GET /api/duties/calendar-counts — one row per date that has something
    // on it. Paints both grids; no Maps call and no hospital population.
    async getCounts(user, from, to) {
        const settings = await this.getSettings();
        const cacheKey = `calendar:counts:${user.id}:${from}:${to}`;

        const cached = await cacheService.get(cacheKey);
        if (cached) return cached;

        // Dates outside the history/horizon window simply have no data
        const todayKey = istDateKey(new Date());
        const historyStart = addDaysToKey(todayKey, -settings.historyDays);
        const horizonEnd = addDaysToKey(todayKey, settings.bookingHorizonDays);
        const lo = from > historyStart ? from : historyStart;
        const hi = to < horizonEnd ? to : horizonEnd;

        let days = [];
        let openCountsAvailable = true;
        if (lo <= hi) {
            if (user.role === 'hospital') {
                days = await this._hospitalCounts(user.id, lo, hi);
            } else {
                ({ days, openCountsAvailable } = await this._staffCounts(user.id, lo, hi));
            }
        }

        const result = {
            from,
            to,
            timezone: 'Asia/Kolkata',
            settings: {
                weekStart: settings.weekStart,
                prefetchPeriods: settings.prefetchPeriods,
                bookingHorizonDays: settings.bookingHorizonDays,
                historyDays: settings.historyDays
            },
            ...(user.role !== 'hospital' && { openCountsAvailable }),
            days
        };

        if (settings.countsCacheSeconds > 0) {
            await cacheService.set(cacheKey, result, settings.countsCacheSeconds);
        }

        return result;
    }



    // Drop a user's cached counts after they change their own duties
    async invalidateCounts(userId) {
        try {
            await cacheService.invalidatePattern(`calendar:counts:${userId}:*`);
        } catch (error) {
            logger.error('Error clearing calendar counts cache:', error);
        }
    }



    async _hospitalCounts(hospitalUserId, lo, hi) {
        const hospital = await Hospital.findOne({ user: hospitalUserId }).select('_id').lean();
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        // From the day before, so an overnight duty can mark its continuation on `lo`
        const duties = await Duty.find({
            hospital: hospital._id,
            status: { $ne: 'cancelled' },
            date: istDayRange(addDaysToKey(lo, -1), hi)
        }).select('date endDate startTime isOvernightDuty status').lean();

        const urgentCutoff = new Date(Date.now() + URGENT_WINDOW_MS);
        const days = new Map();
        const dayFor = (key) => {
            if (!days.has(key)) {
                days.set(key, { date: key, total: 0, filled: 0, open: 0, urgentOpen: 0, expired: 0, continuation: 0 });
            }
            return days.get(key);
        };

        for (const duty of duties) {
            const key = istDateKey(duty.date);
            if (key >= lo && key <= hi) {
                const day = dayFor(key);
                day.total++;
                if (FILLED_STATUSES.includes(duty.status)) {
                    day.filled++;
                } else if (duty.status === 'available') {
                    day.open++;
                    if (hasDutyStarted(duty, urgentCutoff)) day.urgentOpen++;
                } else if (duty.status === 'expired') {
                    day.expired++;
                }
            }

            const continuationKey = overnightContinuationKey(duty);
            if (continuationKey && continuationKey >= lo && continuationKey <= hi) {
                dayFor(continuationKey).continuation++;
            }
        }

        return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    }



    async _staffCounts(staffUserId, lo, hi) {
        const medicalStaff = await MedicalStaff.findOne({ user: staffUserId }).select('_id jobRole').lean();
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found');
        }

        const days = new Map();
        const dayFor = (key) => {
            if (!days.has(key)) {
                days.set(key, {
                    date: key,
                    open: 0,
                    mine: { assigned: 0, active: 0, completed: 0, incomplete: 0, cancelled: 0 },
                    continuation: { mine: 0 }
                });
            }
            return days.get(key);
        };

        // Open duties: same rules as GET /duties/available, minus the Maps step
        let staffLocation = null;
        try {
            staffLocation = await locationBasedStaffService.getStaffCurrentLocation(staffUserId);
        } catch (error) {
            staffLocation = null;
        }

        if (staffLocation) {
            const now = new Date();
            const today = new Date(new Date().setHours(0, 0, 0, 0));
            const range = istDayRange(lo, hi);

            const openDuties = await Duty.find({
                status: 'available',
                staffRole: medicalStaff.jobRole,
                date: { $gte: range.$gte > today ? range.$gte : today, $lt: range.$lt },
                'autoRelist.excludedStaff': { $ne: medicalStaff._id }
            })
                .select('date startTime hospital')
                .populate('hospital', 'coordinates')
                .lean();

            for (const duty of openDuties) {
                const coords = duty.hospital?.coordinates?.coordinates;
                if (!coords || hasDutyStarted(duty, now)) continue;

                const distance = locationBasedStaffService.haversineDistance(
                    staffLocation.latitude, staffLocation.longitude,
                    coords.latitude, coords.longitude
                );
                if (distance > OPEN_DUTY_RADIUS_KM) continue;

                dayFor(istDateKey(duty.date)).open++;
            }
        }

        // My own duties, from the day before for overnight continuations
        const myDuties = await Duty.find({
            assignedTo: medicalStaff._id,
            date: istDayRange(addDaysToKey(lo, -1), hi)
        }).select('date endDate startTime isOvernightDuty status').lean();

        for (const duty of myDuties) {
            const key = istDateKey(duty.date);
            if (key >= lo && key <= hi) {
                const mine = dayFor(key).mine;
                if (duty.status === 'assigned') mine.assigned++;
                else if (ACTIVE_STATUSES.includes(duty.status)) mine.active++;
                else if (duty.status === 'completed') mine.completed++;
                else if (duty.status === 'incomplete') mine.incomplete++;
                else if (duty.status === 'cancelled') mine.cancelled++;
            }

            const continuationKey = overnightContinuationKey(duty);
            if (continuationKey && continuationKey >= lo && continuationKey <= hi) {
                dayFor(continuationKey).continuation.mine++;
            }
        }

        return {
            days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
            openCountsAvailable: Boolean(staffLocation)
        };
    }



    // GET /api/duties/calendar-day — the duties behind one date's counts.
    // Uses the same date rules as getCounts so the list matches the badge.
    async getDay(user, date) {
        return user.role === 'hospital'
            ? this._hospitalDay(user.id, date)
            : this._staffDay(user.id, date);
    }



    async _hospitalDay(hospitalUserId, date) {
        const hospital = await Hospital.findOne({ user: hospitalUserId }).select('_id').lean();
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        const duties = await Duty.find({
            hospital: hospital._id,
            status: { $ne: 'cancelled' },
            date: istDayRange(addDaysToKey(date, -1), date)
        })
            .select('staffRole dutySubType date endDate startTime endTime isOvernightDuty status urgency offeredRate autoRelist.relistCount assignedTo')
            .populate({
                path: 'assignedTo',
                select: 'fullName averageRating totalRatings profilePicture.s3Key verificationStatus user',
                populate: { path: 'user', select: 'name email phone' }
            })
            .sort({ startTime: 1 })
            .lean();

        const onDay = [];
        for (const duty of duties) {
            if (istDateKey(duty.date) === date) onDay.push({ duty, continuation: false });
            else if (overnightContinuationKey(duty) === date) onDay.push({ duty, continuation: true });
        }

        const assignedStaff = [];
        const seen = new Set();
        for (const { duty } of onDay) {
            if (duty.assignedTo && !seen.has(duty.assignedTo._id.toString())) {
                seen.add(duty.assignedTo._id.toString());
                assignedStaff.push(duty.assignedTo);
            }
        }

        const ratings = await ratingAlgorithmService.getEffectiveRatingsForMany(assignedStaff, 'hospital_to_staff');
        const ratingByStaffId = new Map(assignedStaff.map((s, i) => [s._id.toString(), ratings[i].ratingShown]));

        const photoByStaffId = new Map();
        await Promise.all(assignedStaff.map(async (staff) => {
            if (!staff.profilePicture?.s3Key) return;
            try {
                photoByStaffId.set(staff._id.toString(), await s3Service.generatePreSignedURL(staff.profilePicture.s3Key));
            } catch (error) {
                logger.error('Error generating presigned URL for profile picture:', error);
            }
        }));

        const groups = new Map();
        let total = 0;
        let filled = 0;

        for (const { duty, continuation } of onDay) {
            const isFilled = FILLED_STATUSES.includes(duty.status);
            if (!continuation) {
                total++;
                if (isFilled) filled++;
            }

            const groupKey = [continuation, duty.staffRole, duty.dutySubType || '', duty.startTime, duty.endTime].join('|');
            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    staffRole: duty.staffRole,
                    dutySubType: duty.dutySubType || null,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    isOvernightDuty: duty.isOvernightDuty || false,
                    continuation,
                    slots: 0,
                    filled: 0,
                    duties: []
                });
            }

            const group = groups.get(groupKey);
            const staff = duty.assignedTo;
            group.slots++;
            if (isFilled) group.filled++;
            group.duties.push({
                dutyId: duty._id,
                status: duty.status,
                urgency: duty.urgency,
                offeredRate: duty.offeredRate,
                relistCount: duty.autoRelist?.relistCount || 0,
                staff: staff ? {
                    id: staff._id,
                    name: staff.fullName || staff.user?.name || '—',
                    profilePicture: photoByStaffId.get(staff._id.toString()) || null,
                    verificationStatus: staff.verificationStatus,
                    effectiveRating: ratingByStaffId.get(staff._id.toString()) ?? null,
                    phone: staff.user?.phone || null,
                    email: staff.user?.email || null
                } : null
            });
        }

        // Continuations from the night before first, then by start time
        const sortedGroups = [...groups.values()].sort((a, b) =>
            (b.continuation - a.continuation) || a.startTime.localeCompare(b.startTime));

        return { date, summary: { total, filled }, groups: sortedGroups };
    }



    async _staffDay(staffUserId, date) {
        const medicalStaff = await MedicalStaff.findOne({ user: staffUserId }).select('_id').lean();
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found');
        }

        const duties = await Duty.find({
            assignedTo: medicalStaff._id,
            date: istDayRange(addDaysToKey(date, -1), date)
        })
            .select('staffRole dutySubType date endDate startTime endTime isOvernightDuty status urgency offeredRate totalPayment hospital')
            .populate('hospital', 'hospitalLegalName currentAddress city state')
            .sort({ startTime: 1 })
            .lean();

        const result = [];
        for (const duty of duties) {
            const onDate = istDateKey(duty.date) === date;
            const continuation = !onDate && overnightContinuationKey(duty) === date;
            if (!onDate && !continuation) continue;

            result.push({
                dutyId: duty._id,
                status: duty.status,
                staffRole: duty.staffRole,
                dutySubType: duty.dutySubType || null,
                startTime: duty.startTime,
                endTime: duty.endTime,
                isOvernightDuty: duty.isOvernightDuty || false,
                continuation,
                urgency: duty.urgency,
                offeredRate: duty.offeredRate,
                totalPayment: duty.totalPayment,
                hospital: duty.hospital ? {
                    id: duty.hospital._id,
                    name: duty.hospital.hospitalLegalName,
                    address: duty.hospital.currentAddress,
                    city: duty.hospital.city,
                    state: duty.hospital.state
                } : null
            });
        }

        return { date, duties: result };
    }



    // GET /api/duties/:id/fill-progress — where a posted duty is in filling,
    // from states the platform actually records (no offer cascade)
    async getFillProgress(hospitalUserId, dutyId) {
        const hospital = await Hospital.findOne({ user: hospitalUserId }).select('_id').lean();
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId)
            .select('+viewedBy hospital status createdAt assignedAt notifiedCount unassigned15MinNotified unassigned15MinNotifiedAt unfilledCriticalNotified unfilledCriticalNotifiedAt escalatedToCritical escalatedToCriticalAt autoRelist.relistCount autoRelist.history.timestamp assignedTo')
            .populate({
                path: 'assignedTo',
                select: 'fullName profilePicture.s3Key user',
                populate: { path: 'user', select: 'name' }
            })
            .lean();

        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (duty.hospital.toString() !== hospital._id.toString()) {
            throw new ForbiddenError('You can only view your own duties');
        }

        const steps = [
            { key: 'posted', at: duty.createdAt },
            // null on duties posted before this was recorded
            { key: 'offered', count: duty.notifiedCount ?? null, at: duty.createdAt },
            { key: 'viewed', count: Array.isArray(duty.viewedBy) ? duty.viewedBy.length : null }
        ];

        if (duty.unassigned15MinNotified) {
            steps.push({ key: 'unfilled_15min', at: duty.unassigned15MinNotifiedAt || null });
        }
        if (duty.escalatedToCritical) {
            steps.push({ key: 'escalated_to_admins', at: duty.escalatedToCriticalAt || null });
        }
        if (duty.unfilledCriticalNotified) {
            steps.push({ key: 'unfilled_critical', at: duty.unfilledCriticalNotifiedAt || null });
        }

        const relistCount = duty.autoRelist?.relistCount || 0;
        if (relistCount > 0) {
            const history = duty.autoRelist.history || [];
            steps.push({ key: 'relisted', count: relistCount, at: history.length ? history[history.length - 1].timestamp : null });
        }

        const staff = duty.assignedTo;
        if (staff && FILLED_STATUSES.includes(duty.status)) {
            let profilePicture = null;
            if (staff.profilePicture?.s3Key) {
                try {
                    profilePicture = await s3Service.generatePreSignedURL(staff.profilePicture.s3Key);
                } catch (error) {
                    logger.error('Error generating presigned URL for profile picture:', error);
                }
            }
            steps.push({
                key: 'accepted',
                at: duty.assignedAt || null,
                staff: { name: staff.fullName || staff.user?.name || '—', profilePicture }
            });
        } else if (duty.status === 'expired' || duty.status === 'cancelled') {
            steps.push({ key: duty.status, at: null });
        }

        return {
            dutyId: duty._id,
            status: duty.status,
            current: steps[steps.length - 1].key,
            steps
        };
    }
}

module.exports = new DutyCalendarService();
