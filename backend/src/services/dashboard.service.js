const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const { getCurrentIST } = require('../utils/helpers');
const redisClient = require('../config/redis');
const geocodingService = require('./geocoding.service');
const ratingAlgorithmService = require('./ratingAlgorithm.service');
const staffLocator = require('./staffLocator.service');
const cacheService = require('./cache.service');
const activityLogEmitter = require('./activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const {
    NotFoundError,
    ForbiddenError
} = require('../middleware/error.middleware');

const { istDateKey, istDayStart, addDaysToKey } = require('../utils/calendar.helper');
const { bucketsBetween, bucketKey } = require('../utils/analytics.helper');

const EARNINGS_DEFAULT_BUCKETS = { week: 8, month: 6 };
const EARNINGS_MAX_DAYS = 400;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const roundRupees = (n) => Math.round(n * 100) / 100;

// The earnings range for a period, in IST day keys. Without from/to it covers
// the last 8 weeks or 6 months up to today.
function earningsRange(period, from, to) {
    const toKey = to || istDateKey(new Date());
    if (from) return { from, to: toKey };
    if (period === 'week') return { from: addDaysToKey(toKey, -(EARNINGS_DEFAULT_BUCKETS.week * 7 - 1)), to: toKey };
    const [year, month] = toKey.split('-').map(Number);
    const first = new Date(Date.UTC(year, month - EARNINGS_DEFAULT_BUCKETS.month, 1)).toISOString().slice(0, 10);
    return { from: first, to: toKey };
}

// 'Oct 2026' for a month, '5 Oct' for the week starting that Monday
function bucketLabel(key, period) {
    const [year, month, day] = key.split('-').map(Number);
    return period === 'month' ? `${MONTHS[month - 1]} ${year}` : `${day} ${MONTHS[month - 1]}`;
}

class DashboardService {
    // Get staff overview — rating with month-over-month growth
    async getStaffOverview(userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId })
            .select('averageRating totalRatings');

        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found');
        }

        const now = getCurrentIST();
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1);

        // Get reviews this month vs last month to compute rating growth
        const Review = require('../models/Review');
        const [thisMonthReviews, lastMonthReviews] = await Promise.all([
            Review.aggregate([
                {
                    $match: {
                        medicalStaff: medicalStaff._id,
                        createdAt: { $gte: thisMonthStart }
                    }
                },
                { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
            ]),
            Review.aggregate([
                {
                    $match: {
                        medicalStaff: medicalStaff._id,
                        createdAt: { $gte: lastMonthStart, $lt: lastMonthEnd }
                    }
                },
                { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
            ])
        ]);

        const thisMonthAvg = thisMonthReviews[0]?.avg || 0;
        const lastMonthAvg = lastMonthReviews[0]?.avg || 0;

        let growthPercent = 0;
        let growthTrend = 'neutral';
        if (lastMonthAvg > 0) {
            growthPercent = Math.round(((thisMonthAvg - lastMonthAvg) / lastMonthAvg) * 100);
            growthTrend = growthPercent >= 0 ? 'up' : 'down';
        } else if (thisMonthAvg > 0) {
            growthPercent = 100;
            growthTrend = 'up';
        }

        // .select() above deliberately excludes `user` to keep the query
        // lean — userId is already in scope as this function's own
        // parameter, same value, so a fresh fetch isn't needed.
        const { ratingShown, breakdown } = await ratingAlgorithmService.getEffectiveRating(
            { user: userId, averageRating: medicalStaff.averageRating, totalRatings: medicalStaff.totalRatings },
            'hospital_to_staff'
        );

        return {
            averageRating: parseFloat((medicalStaff.averageRating || 0).toFixed(1)),
            totalRatings: medicalStaff.totalRatings || 0,
            effectiveRating: ratingShown,
            ratingBreakdown: breakdown,
            growth: {
                percent: Math.abs(growthPercent),
                trend: growthTrend,
                label: `${growthPercent >= 0 ? '+' : '-'}${Math.abs(growthPercent)}%`
            }
        };
    }


    // Get comprehensive staff statistics
    async getStaffStats(staffId) {
        const now = getCurrentIST();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [
            totalDuties,
            completedDuties,
            upcomingDuties,
            ongoingDuties,
            thisMonthDuties,
            thisMonthCompleted
        ] = await Promise.all([
            Duty.countDocuments({ assignedTo: staffId }),
            Duty.countDocuments({ assignedTo: staffId, status: 'completed' }),
            Duty.countDocuments({ assignedTo: staffId, status: 'assigned', date: { $gte: today } }),
            Duty.countDocuments({ assignedTo: staffId, status: { $in: ['assigned', 'enroute', 'in-progress'] } }),
            Duty.countDocuments({ assignedTo: staffId, createdAt: { $gte: thisMonth } }),
            Duty.countDocuments({ assignedTo: staffId, status: 'completed', completedAt: { $gte: thisMonth } })
        ]);

        return {
            totalDuties,
            completedDuties,
            upcomingDuties,
            ongoingDuties,
            thisMonthDuties,
            thisMonthCompleted,
            completionRate: totalDuties > 0 ? (completedDuties / totalDuties * 100).toFixed(1) : '0.0',
            monthlyCompletionRate: thisMonthDuties > 0 ? (thisMonthCompleted / thisMonthDuties * 100).toFixed(1) : '0.0'
        };
    }


    // Get upcoming duties with details
    async getUpcomingDuties(userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found');
        }

        const now = getCurrentIST();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const duties = await Duty.find({
            assignedTo: medicalStaff._id,
            status: 'assigned',
            date: { $gte: today }
        })
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .sort({ date: 1, startTime: 1 })
            .limit(10);

        return duties;
    }


    // Get earnings information with month-over-month growth. With a period
    // ('week' | 'month', optional from/to IST days) it adds a series and the
    // paid / pending split for that range.
    async getEarnings(staffId, options = {}) {
        const now = getCurrentIST();
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1); // exclusive

        const sumAndCount = { $group: { _id: null, total: { $sum: '$totalPayment' }, count: { $sum: 1 } } };
        const paidOrPending = {
            $group: {
                _id: null,
                paid: { $sum: { $cond: [{ $eq: ['$isPaid', true] }, '$totalPayment', 0] } },
                pending: {
                    $sum: {
                        $cond: [
                            { $and: [{ $ne: ['$isPaid', true] }, { $or: [{ $eq: ['$isPaid', false] }, { $eq: ['$paymentMethod', 'will_pay_later'] }] }] },
                            '$totalPayment',
                            0
                        ]
                    }
                }
            }
        };

        // One round trip instead of three
        const [facets] = await Duty.aggregate([
            { $match: { assignedTo: staffId, status: 'completed' } },
            {
                $facet: {
                    allTime: [sumAndCount],
                    thisMonth: [{ $match: { completedAt: { $gte: thisMonthStart } } }, sumAndCount],
                    lastMonth: [{ $match: { completedAt: { $gte: lastMonthStart, $lt: lastMonthEnd } } }, sumAndCount],
                    payment: [paidOrPending]
                }
            }
        ]);

        const allTime = facets?.allTime || [];
        const thisMonth = facets?.thisMonth || [];
        const lastMonth = facets?.lastMonth || [];
        const totalEarnings = allTime[0]?.total || 0;
        const totalCount = allTime[0]?.count || 0;
        const thisMonthEarnings = thisMonth[0]?.total || 0;
        const lastMonthEarnings = lastMonth[0]?.total || 0;

        // Month-over-month growth %
        let growthPercent = 0;
        let growthTrend = 'neutral'; // up | down | neutral
        if (lastMonthEarnings > 0) {
            growthPercent = Math.round(((thisMonthEarnings - lastMonthEarnings) / lastMonthEarnings) * 100);
            growthTrend = growthPercent >= 0 ? 'up' : 'down';
        } else if (thisMonthEarnings > 0) {
            growthPercent = 100;
            growthTrend = 'up';
        }

        const result = {
            totalEarnings,
            completedDutiesCount: totalCount,
            averagePerDuty: totalCount > 0 ? parseFloat((totalEarnings / totalCount).toFixed(2)) : 0,
            thisMonthEarnings,
            lastMonthEarnings,
            growth: {
                percent: Math.abs(growthPercent),
                trend: growthTrend,
                label: `${growthPercent >= 0 ? '+' : '-'}${Math.abs(growthPercent)}%`
            },
            // All time; with a period these are replaced by the period's own
            paid: roundRupees(facets?.payment?.[0]?.paid || 0),
            pending: roundRupees(facets?.payment?.[0]?.pending || 0)
        };

        if (options.period) {
            Object.assign(result, await this._earningsSeries(staffId, options));
        }

        return result;
    }

    // series: [{ key, label, earnings, duties }] for each week or month in the range
    async _earningsSeries(staffId, { period, from, to }) {
        const range = earningsRange(period, from, to);
        const duties = await Duty.find({
            assignedTo: staffId,
            status: 'completed',
            completedAt: { $gte: istDayStart(range.from), $lt: istDayStart(addDaysToKey(range.to, 1)) }
        })
            .select('completedAt totalPayment isPaid paymentMethod')
            .lean();

        const rows = new Map(bucketsBetween(range.from, range.to, period).map(key => [key, { earnings: 0, duties: 0 }]));
        let paid = 0;
        let pending = 0;
        for (const duty of duties) {
            const amount = duty.totalPayment || 0;
            const row = rows.get(bucketKey(duty.completedAt, period));
            if (row) {
                row.earnings += amount;
                row.duties += 1;
            }
            if (duty.isPaid === true) paid += amount;
            else if (duty.isPaid === false || duty.paymentMethod === 'will_pay_later') pending += amount;
        }

        return {
            period,
            from: range.from,
            to: range.to,
            series: [...rows.entries()].map(([key, row]) => ({
                key,
                label: bucketLabel(key, period),
                earnings: roundRupees(row.earnings),
                duties: row.duties
            })),
            paid: roundRupees(paid),
            pending: roundRupees(pending)
        };
    }


    // Get availability status
    async getAvailabilityStatus(userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found');
        }

        return {
            isAvailable: medicalStaff.isAvailable,
            profileComplete: medicalStaff.isProfileComplete,
            lastUpdated: medicalStaff.updatedAt
        };
    }



    // --- Dashboard Location (WebSocket-driven, 2-min TTL) ---

    _locationPermissionKey(userId) {
        return `dashboard:location:permission:${userId}`;
    }

    _locationDataKey(userId) {
        return `dashboard:location:${userId}`;
    }

    // Called by HTTP API — stores permission flag only (30-day TTL, survives disconnects)
    async grantDashboardLocationPermission(userId) {
        const client = await redisClient.getClientAsync();
        await client.setex(this._locationPermissionKey(userId), 60 * 60 * 24 * 30, 'true');

        // Durable consent record; the Redis flag above is only the fast path
        const changed = await MedicalStaff.findOneAndUpdate(
            { user: userId, 'locationConsent.granted': { $ne: true } },
            { $set: { 'locationConsent.granted': true, 'locationConsent.grantedAt': new Date() } },
            { projection: { fullName: 1 } }
        );
        if (changed) this._logConsent(userId, changed.fullName, true);
    }

    _logConsent(userId, name, granted) {
        const person = { _id: userId, name: name || 'Staff', role: 'staff' };
        activityLogEmitter.emitUserActivity(
            ACTIVITY_ACTIONS.LOCATION_CONSENT_CHANGED,
            person,
            { userId, name: person.name, role: 'staff' },
            { granted }
        ).catch(() => {});
    }

    // Called by HTTP API or WebSocket revoke — clears both permission and location
    async revokeDashboardLocationPermission(userId) {
        const client = await redisClient.getClientAsync();
        await Promise.all([
            client.del(this._locationPermissionKey(userId)),
            client.del(this._locationDataKey(userId)),
            staffLocator.removeLivePosition(userId)
        ]);

        const changed = await MedicalStaff.findOneAndUpdate(
            { user: userId, 'locationConsent.granted': true },
            { $set: { 'locationConsent.granted': false, 'locationConsent.revokedAt': new Date() } },
            { projection: { fullName: 1 } }
        );
        if (changed) this._logConsent(userId, changed.fullName, false);
    }

    async isDashboardLocationPermitted(userId) {
        const client = await redisClient.getClientAsync();
        return (await client.get(this._locationPermissionKey(userId))) === 'true';
    }

    // Called by WebSocket every 30 seconds — resets the 2-min TTL on each update
    async setDashboardLocationViaSocket(userId, latitude, longitude) {
        geocodingService.validateCoordinates(latitude, longitude);

        const permitted = await this.isDashboardLocationPermitted(userId);
        if (!permitted) {
            throw new ForbiddenError('Location permission not granted');
        }

        const client = await redisClient.getClientAsync();
        const locationData = {
            latitude,
            longitude,
            updatedAt: new Date().toISOString(),
            source: 'websocket'
        };

        // Store reviewers test from abroad: demo doctors keep their profile address
        if (await this._isDemoStaff(userId)) return locationData;

        // 2-minute TTL: auto-expires if staff goes offline and stops sending updates
        await client.setex(this._locationDataKey(userId), 120, JSON.stringify(locationData));
        // Lets duty offers find staff who are near a hospital right now
        await staffLocator.addLivePosition(userId, latitude, longitude);
        return locationData;
    }

    // Cached for 10 minutes; this runs on every location update
    async _isDemoStaff(userId) {
        const key = `demo:staff:${userId}`;
        const cached = await cacheService.get(key);
        if (cached !== null && cached !== undefined) return cached === true;
        const isDemo = Boolean(await MedicalStaff.exists({ user: userId, isDemo: true }));
        await cacheService.set(key, isDemo, 600);
        return isDemo;
    }

    // Get the live location (null if staff offline or TTL expired)
    async getDashboardLocation(userId) {
        const client = await redisClient.getClientAsync();
        const raw = await client.get(this._locationDataKey(userId));
        return raw ? JSON.parse(raw) : null;
    }

    // Backward-compatible — used by getStaffLocationForDuties and getLocationStatus endpoint
    async getCachedLocationPermission(userId) {
        const client = await redisClient.getClientAsync();
        const [permittedRaw, locationRaw] = await Promise.all([
            client.get(this._locationPermissionKey(userId)),
            client.get(this._locationDataKey(userId))
        ]);

        const permissionGranted = permittedRaw === 'true';
        const currentLocation = locationRaw ? JSON.parse(locationRaw) : null;

        return {
            permissionGranted,
            currentLocation,
            cached: !!currentLocation
        };
    }

    // Get staff location for duties using only dashboard websocket location.
    async getStaffLocationForDuties(userId) {
        const location = await this.getDashboardLocation(userId);

        if (!location) {
            throw new NotFoundError('Staff location not found. Please grant location permission on the dashboard.');
        }

        return {
            location,
            source: 'websocket',
            permissionGranted: true
        };
    }
}

module.exports = new DashboardService();
module.exports.earningsRange = earningsRange;
module.exports.EARNINGS_MAX_DAYS = EARNINGS_MAX_DAYS;
