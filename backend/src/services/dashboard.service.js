const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const { getCurrentIST } = require('../utils/helpers');
const redisClient = require('../config/redis');
const geocodingService = require('./geocoding.service');

class DashboardService {
    // Get staff overview — rating with month-over-month growth
    async getStaffOverview(userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId })
            .select('averageRating totalRatings');

        if (!medicalStaff) {
            throw new Error('Medical staff profile not found');
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
            throw new Error('Medical staff profile not found');
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
            throw new Error('Medical staff profile not found');
        }

        return {
            isAvailable: medicalStaff.isAvailable,
            profileComplete: medicalStaff.isProfileComplete,
            lastUpdated: medicalStaff.updatedAt
        };
    }



    // Check and store location permission for dashboard
    async checkDashboardLocationPermission(userId, locationData, permissionGranted) {
        try {
            const cacheKey = `dashboard:location:${userId}`;
            
            if (permissionGranted) {
                // Validate coordinates
                geocodingService.validateCoordinates(locationData.latitude, locationData.longitude);
                
                const locationInfo = {
                    permissionGranted: true,
                    currentLocation: {
                        latitude: locationData.latitude,
                        longitude: locationData.longitude,
                        updatedAt: new Date().toISOString(),
                        source: 'browser'
                    },
                    lastUpdated: new Date().toISOString()
                };
                
                // Store in Redis with 24-hour TTL
                const client = await redisClient.getClientAsync();
                await client.setex(cacheKey, 86400, JSON.stringify(locationInfo));
                
                return {
                    success: true,
                    permissionGranted: true,
                    message: 'Location permission granted for dashboard',
                    location: locationInfo.currentLocation
                };
            } else {
                // Permission denied - remove from cache
                const client = await redisClient.getClientAsync();
                await client.del(cacheKey);
                
                return {
                    success: true,
                    permissionGranted: false,
                    message: 'Location permission denied for dashboard',
                    location: null
                };
            }
        } catch (error) {
            throw new Error(`Dashboard location permission check failed: ${error.message}`);
        }
    }
    


    // Get cached location permission status
    async getCachedLocationPermission(userId) {
        try {
            const cacheKey = `dashboard:location:${userId}`;
            const client = await redisClient.getClientAsync();
            const cached = await client.get(cacheKey);
            
            if (cached) {
                const locationData = JSON.parse(cached);
                return {
                    permissionGranted: locationData.permissionGranted,
                    currentLocation: locationData.currentLocation,
                    cached: true,
                    lastUpdated: locationData.lastUpdated
                };
            }
            
            return {
                permissionGranted: false,
                currentLocation: null,
                cached: false
            };
        } catch (error) {
            console.error('Error getting cached location permission:', error);
            return {
                permissionGranted: false,
                currentLocation: null,
                cached: false
            };
        }
    }
    


    // Update current location (for subsequent dashboard visits)
    async updateCurrentLocation(userId, locationData) {
        try {
            const cacheKey = `dashboard:location:${userId}`;
            const client = await redisClient.getClientAsync();
            
            // Check if permission was previously granted
            const existing = await client.get(cacheKey);
            if (!existing) {
                throw new Error('No location permission found. Please grant permission first.');
            }
            
            const existingData = JSON.parse(existing);
            if (!existingData.permissionGranted) {
                throw new Error('Location permission was denied. Please grant permission first.');
            }
            
            // Validate new coordinates
            geocodingService.validateCoordinates(locationData.latitude, locationData.longitude);
            
            // Update location
            const updatedLocationInfo = {
                permissionGranted: true,
                currentLocation: {
                    latitude: locationData.latitude,
                    longitude: locationData.longitude,
                    updatedAt: new Date().toISOString(),
                    source: 'browser'
                },
                lastUpdated: new Date().toISOString()
            };
            
            // Update cache
            await client.setex(cacheKey, 86400, JSON.stringify(updatedLocationInfo));
            
            return {
                success: true,
                message: 'Location updated successfully',
                location: updatedLocationInfo.currentLocation
            };
        } catch (error) {
            throw new Error(`Location update failed: ${error.message}`);
        }
    }
    

    
    // Get staff location with fallback logic
    async getStaffLocationForDuties(userId) {
        try {
            // First check dashboard location cache
            const dashboardLocation = await this.getCachedLocationPermission(userId);
            
            if (dashboardLocation.permissionGranted && dashboardLocation.currentLocation) {
                return {
                    location: dashboardLocation.currentLocation,
                    source: 'browser',
                    permissionGranted: true
                };
            }
            
            // Fallback to profile location
            const staff = await MedicalStaff.findOne({ user: userId })
                .select('coordinates')
                .lean();
            
            if (!staff || !staff.coordinates || !staff.coordinates.coordinates) {
                throw new Error('Staff location not found. Please update your profile or grant location permission.');
            }
            
            return {
                location: {
                    latitude: staff.coordinates.coordinates.latitude,
                    longitude: staff.coordinates.coordinates.longitude,
                    source: 'profile'
                },
                source: 'profile',
                permissionGranted: false
            };
        } catch (error) {
            throw new Error(`Failed to get staff location: ${error.message}`);
        }
    }
}

module.exports = new DashboardService();