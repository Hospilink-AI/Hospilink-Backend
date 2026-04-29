const redisClient = require('../config/redis');
const geocodingService = require('../services/geocoding.service');


// Get multiple staff locations in batch for performance
async function getBatchStaffLocations(staffUserIds) {
    try {
        console.log('🔍 DEBUG: Fetching batch locations for User IDs:', staffUserIds);
        const redis = await redisClient.getClientAsync();
        
        const locationPromises = staffUserIds.map(async (userId) => {
            try {
                const key = `hospilink:staff_location:${userId}`;
                console.log('🔍 DEBUG: Checking Redis key:', key);
                const data = await redis.get(key);
                console.log('🔍 DEBUG: Found data for user', userId, ':', data ? 'YES' : 'NO');
                return {
                    userId,
                    location: data ? JSON.parse(data) : null
                };
            } catch (error) {
                console.error(`Error getting location for user ${userId}:`, error);
                return { userId, location: null };
            }
        });
        
        const results = await Promise.all(locationPromises);
        console.log('🔍 DEBUG: Batch location results:', results);
        
        // Convert to map for easy lookup
        const locationMap = {};
        results.forEach(result => {
            if (result.location) {
                locationMap[result.userId] = result.location;
            }
        });
        
        console.log('🔍 DEBUG: Final locationMap keys:', Object.keys(locationMap));
        return locationMap;
    } catch (error) {
        console.error('Error in batch location retrieval:', error);
        return {};
    }
}


// Format individual active duty with enhanced information
async function formatActiveDuty(duty, realtimeLocations = {}) {
    try {
        const staff = duty.assignedTo;
        const hospital = duty.hospital;
        
        // Determine status
        let statusInfo = {
            status: duty.status
        };

        // Calculate distance and duration from staff's REAL-TIME location to hospital
        let distanceToHospital = null;

        if (staff && hospital.coordinates) {
            try {
                let staffLat, staffLng, locationSource = 'profile';
                
                // Check real-time location first
                const currentLocation = realtimeLocations[staff.user._id];
                
                if (currentLocation && currentLocation.latitude && currentLocation.longitude) {
                    // Use real-time location if available
                    staffLat = currentLocation.latitude;
                    staffLng = currentLocation.longitude;
                    locationSource = 'realtime';
                } else if (staff.coordinates && staff.coordinates.coordinates) {
                    // Fallback to profile location
                    staffLat = staff.coordinates.coordinates.latitude;
                    staffLng = staff.coordinates.coordinates.longitude;
                    locationSource = 'profile';
                } else {
                    // No location available
                    distanceToHospital = null;
                }
                
                if (staffLat && staffLng) {
                    const distanceResult = await geocodingService.getCachedDistance(
                        staffLat,
                        staffLng,
                        hospital.coordinates.coordinates.latitude,
                        hospital.coordinates.coordinates.longitude
                    );

                    distanceToHospital = {
                        distance: distanceResult.distance,
                        distanceText: distanceResult.distanceText,
                        estimatedTime: distanceResult.duration,
                        estimatedTimeText: distanceResult.durationText,
                        source: locationSource // Track data source
                    };
                }
            } catch (distanceError) {
                console.error('Error calculating distance:', distanceError);
            }
        }

        return {
            dutyId: duty._id,
            role: duty.staffRole,
            formattedRole: duty.formattedRole,
            hospital: {
                id: hospital._id,
                name: hospital.hospitalLegalName,
                currentAddress: hospital.currentAddress,
                city: hospital.city,
                state: hospital.state,
                pincode: hospital.pincode,
                coordinates: hospital.coordinates
            },
            staff: staff ? {
                id: staff._id,
                name: staff.fullName,
                userName: staff.user?.name || staff.fullName,
                email: staff.user?.email || staff.email,
                currentAddress: staff.currentAddress,
                city: staff.city,
                state: staff.state,
                pincode: staff.pincode,
                location: staff.currentAddress ? 
                    `${staff.currentAddress}, ${staff.city}, ${staff.state} - ${staff.pincode}` : 
                    `${staff.city}, ${staff.state} - ${staff.pincode}`,
                coordinates: staff.coordinates
            } : null,
            timing: {
                date: duty.date,
                startTime: duty.startTime,
                endTime: duty.endTime,
                urgency: duty.urgency,
                assignedAt: duty.assignedAt,
                enrouteAt: duty.enrouteAt,
                startedAt: duty.startedAt
            },
            status: statusInfo,
            distance: distanceToHospital,
            description: duty.description,
            offeredRate: duty.offeredRate,
            totalPayment: duty.totalPayment
        };
    } catch (error) {
        console.error('Error formatting duty:', error);
        throw error;
    }
}

module.exports = {
    getBatchStaffLocations,
    formatActiveDuty
};