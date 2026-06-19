const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const { getCurrentIST } = require('../utils/helpers');
const redisClient = require('../config/redis');
const geocodingService = require('./geocoding.service');
const {
    ValidationError,
    NotFoundError,
    ForbiddenError
} = require('../middleware/error.middleware');

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

        return {
            averageRating: parseFloat((medicalStaff.averageRating || 0).toFixed(1)),
            totalRatings: medicalStaff.totalRatings || 0,
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


    // Get earnings information with month-over-month growth
    async getEarnings(staffId) {
        const now = getCurrentIST();
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1); // exclusive

        const [allTime, thisMonth, lastMonth] = await Promise.all([
            Duty.aggregate([
                { $match: { assignedTo: staffId, status: 'completed' } },
                { $group: { _id: null, total: { $sum: '$totalPayment' }, count: { $sum: 1 } } }
            ]),
            Duty.aggregate([
                {
                    $match: {
                        assignedTo: staffId,
                        status: 'completed',
                        completedAt: { $gte: thisMonthStart }
                    }
                },
                { $group: { _id: null, total: { $sum: '$totalPayment' }, count: { $sum: 1 } } }
            ]),
            Duty.aggregate([
                {
                    $match: {
                        assignedTo: staffId,
                        status: 'completed',
                        completedAt: { $gte: lastMonthStart, $lt: lastMonthEnd }
                    }
                },
                { $group: { _id: null, total: { $sum: '$totalPayment' }, count: { $sum: 1 } } }
            ])
        ]);

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

        return {
            totalEarnings,
            completedDutiesCount: totalCount,
            averagePerDuty: totalCount > 0 ? parseFloat((totalEarnings / totalCount).toFixed(2)) : 0,
            thisMonthEarnings,
            lastMonthEarnings,
            growth: {
                percent: Math.abs(growthPercent),
                trend: growthTrend,
                label: `${growthPercent >= 0 ? '+' : '-'}${Math.abs(growthPercent)}%`
            }
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
    }

    // Called by HTTP API or WebSocket revoke — clears both permission and location
    async revokeDashboardLocationPermission(userId) {
        const client = await redisClient.getClientAsync();
        await Promise.all([
            client.del(this._locationPermissionKey(userId)),
            client.del(this._locationDataKey(userId))
        ]);
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

        // 2-minute TTL: auto-expires if staff goes offline and stops sending updates
        await client.setex(this._locationDataKey(userId), 120, JSON.stringify(locationData));
        return locationData;
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
        try {
            const location = await this.getDashboardLocation(userId);

            if (!location) {
                throw new NotFoundError('Staff location not found. Please grant location permission on the dashboard.');
            }

            return {
                location,
                source: 'websocket',
                permissionGranted: true
            };
        } catch (error) {
            throw error;
        }
    }
}

module.exports = new DashboardService();