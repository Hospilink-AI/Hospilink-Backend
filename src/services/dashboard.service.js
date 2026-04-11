const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const { getCurrentIST } = require('../utils/helpers');
const redisClient = require('../config/redis');
const geocodingService = require('./geocoding.service');

class DashboardService {
    // Get staff overview with profile and basic stats
    async getStaffOverview(userId) {

        const medicalStaff = await MedicalStaff.findOne({ user: userId });

        if (!medicalStaff) {
            throw new Error('Medical staff profile not found');
        }

        const stats = await this.getStaffStats(medicalStaff._id);
        const recentDuties = await this.getRecentDuties(medicalStaff._id);

        return {
            profile: {
                ...medicalStaff.toObject(),
                rating: {
                    averageRating: medicalStaff.averageRating,
                    totalRatings: medicalStaff.totalRatings
                }
            },
            stats,
            recentDuties
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


    // Get recent duties for dashboard
    async getRecentDuties(staffId, limit = 5) {
        return await Duty.find({ assignedTo: staffId })
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .sort({ createdAt: -1 })
            .limit(limit);
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


    // Get earnings information
    async getEarnings(staffId) {
        const completedDuties = await Duty.find({
            assignedTo: staffId,
            status: 'completed'
        }).select('totalPayment completedAt');

        const totalEarnings = completedDuties.reduce((sum, duty) => sum + (duty.totalPayment || 0), 0);

        return {
            totalEarnings: totalEarnings,
            completedDutiesCount: completedDuties.length,
            averagePerDuty: completedDuties.length > 0 ? (totalEarnings / completedDuties.length).toFixed(2) : '0.0'
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