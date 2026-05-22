const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const geocodingService = require('./geocoding.service');
const redisClient = require('../config/redis');
const dashboardService = require('./dashboard.service');

class LocationBasedStaffService {
    // Calculate bounding box for 50km radius
    getBoundingBox(lat, lng, radiusKm = 50) {
        const earthRadius = 6371; // km
        const latDelta = radiusKm / earthRadius;
        const lngDelta = radiusKm / (earthRadius * Math.cos(lat * Math.PI / 180));
        
        return {
            minLat: lat - latDelta,
            maxLat: lat + latDelta,
            minLng: lng - lngDelta,
            maxLng: lng + lngDelta
        };
    }

    // Get nearby staff by role with optimized query
    async getNearbyStaffByRole(hospitalCoords, requiredRole, limit = 100) {
        const cacheKey = `nearby_staff:${requiredRole}:${Math.round(hospitalCoords.latitude*1000)}:${Math.round(hospitalCoords.longitude*1000)}`;
        
        try {
            const redis = await redisClient.getClientAsync();
            const cached = await redis.get(cacheKey);
            
            if (cached) {
                return JSON.parse(cached);
            }

            const box = this.getBoundingBox(hospitalCoords.latitude, hospitalCoords.longitude);
            
            const nearbyStaff = await MedicalStaff.find({
                isAvailable: true,
                jobRole: requiredRole,
                'coordinates.coordinates.latitude': { $gte: box.minLat, $lte: box.maxLat },
                'coordinates.coordinates.longitude': { $gte: box.minLng, $lte: box.maxLng }
            })
            .select('user fullName jobRole coordinates isAvailable')
            .populate('user', '_id')
            .limit(limit)
            .lean();

            // Filter by actual distance using Google Maps API (bounding box is approximate)
            const staffWithinRadius = [];
            for (const staff of nearbyStaff) {
                try {
                    const distanceResult = await geocodingService.calculateDistanceAndETA(
                        hospitalCoords.latitude,
                        hospitalCoords.longitude,
                        staff.coordinates.coordinates.latitude,
                        staff.coordinates.coordinates.longitude
                    );
                    
                    if (distanceResult.distance <= 50) {
                        staffWithinRadius.push({
                            ...staff,
                            distance: distanceResult.distance,
                            duration: distanceResult.duration,
                            distanceText: distanceResult.distanceText,
                            durationText: distanceResult.durationText
                        });
                    }
                } catch (error) {
                    console.error('Error calculating distance for staff:', error);
                    // Skip this staff if distance calculation fails
                    continue;
                }
            }

            // Sort by distance
            staffWithinRadius.sort((a, b) => a.distance - b.distance);

            // Cache for 5 minutes
            await redis.setex(cacheKey, 300, JSON.stringify(staffWithinRadius));
            
            return staffWithinRadius;
        } catch (error) {
            console.error('Error getting nearby staff:', error);
            return [];
        }
    }

    // Get available jobs with distance for staff member
    async getAvailableJobsWithDistance(staffId, filters = {}) {
        const medicalStaff = await MedicalStaff.findOne({ user: staffId });
        if (!medicalStaff) {
            throw new Error('Medical staff profile not found');
        }

        // Get staff current location
        const staffLocation = await this.getStaffCurrentLocation(staffId);
        
        // Get current date and time for filtering
        const now = new Date();
        const today = new Date(now.setHours(0, 0, 0, 0));
        
        // Build base query for available duties matching staff role
        const query = {
            status: 'available',
            staffRole: medicalStaff.jobRole,
            date: { $gte: today } // Include today's duties and future
        };

        // Add additional filters
        if (filters.urgency) query.urgency = filters.urgency;
        if (filters.city) {
            const hospitals = await Hospital.find({ city: filters.city }).select('_id');
            query.hospital = { $in: hospitals.map(h => h._id) };
        }

        const duties = await Duty.find(query)
            .populate('hospital', 'hospitalLegalName coordinates city state')
            .sort({ date: 1, startTime: 1 })
            .limit(50);

        // Calculate distances and filter within 50km using Google Maps API
        // Also filter out duties that have already started
        const currentTime = new Date();
        const jobsWithDistance = [];
        
        for (const duty of duties) {
            if (!duty.hospital?.coordinates?.coordinates) {
                continue;
            }

            // Skip duties that have already started
            // Compare duty date and start time with current date/time
            const dutyDate = new Date(duty.date);
            const dutyDateTime = new Date(dutyDate);
            
            // Parse start time (format: "HH:MM" or "HH:MM AM/PM")
            const startTimeParts = duty.startTime.match(/(\d+):(\d+)\s*(AM|PM)?/i);
            if (startTimeParts) {
                let hours = parseInt(startTimeParts[1]);
                const minutes = parseInt(startTimeParts[2]);
                const meridiem = startTimeParts[3];
                
                // Convert to 24-hour format if AM/PM is present
                if (meridiem) {
                    if (meridiem.toUpperCase() === 'PM' && hours !== 12) {
                        hours += 12;
                    } else if (meridiem.toUpperCase() === 'AM' && hours === 12) {
                        hours = 0;
                    }
                }
                
                dutyDateTime.setHours(hours, minutes, 0, 0);
            }
            
            // Skip if duty has already started
            if (dutyDateTime <= currentTime) {
                console.log(`Skipping duty ${duty._id} - already started at ${duty.startTime} on ${duty.date}`);
                continue;
            }

            try {
                const distanceResult = await geocodingService.calculateDistanceAndETA(
                    staffLocation.latitude,
                    staffLocation.longitude,
                    duty.hospital.coordinates.coordinates.latitude,
                    duty.hospital.coordinates.coordinates.longitude
                );

                if (distanceResult.distance <= 50) {
                    jobsWithDistance.push({
                        ...duty.toObject(),
                        distance: distanceResult.distance,
                        duration: distanceResult.duration,
                        distanceText: distanceResult.distanceText,
                        durationText: distanceResult.durationText
                    });
                }
            } catch (error) {
                console.error('Error calculating distance for duty:', error);
                // Skip this duty if distance calculation fails
                continue;
            }
        }

        // Sort by distance
        jobsWithDistance.sort((a, b) => a.distance - b.distance);

        return {
            jobs: jobsWithDistance,
            staffLocation
        };
    }

    // Helper method to get staff current location
    async getStaffCurrentLocation(staffId) {
        try {
            const locationInfo = await dashboardService.getStaffLocationForDuties(staffId);
            return locationInfo.location;
        } catch (error) {
            // Fallback to profile
            const staff = await MedicalStaff.findOne({ user: staffId })
                .select('coordinates')
                .lean();
                
            if (!staff?.coordinates?.coordinates) {
                throw new Error('Staff location not found');
            }
            
            return {
                latitude: staff.coordinates.coordinates.latitude,
                longitude: staff.coordinates.coordinates.longitude
            };
        }
    }
}

module.exports = new LocationBasedStaffService();