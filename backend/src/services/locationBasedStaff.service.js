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



    // Calculate using haversine
    haversineDistance(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

        console.log(`[AvailableJobs] Staff ID: ${staffId} | Job Role: ${medicalStaff.jobRole}`);

        // Get staff current location (browser GPS from Redis, falls back to profile)
        const staffLocation = await this.getStaffCurrentLocation(staffId);
        console.log(`[AvailableJobs] Staff location → lat: ${staffLocation.latitude}, lng: ${staffLocation.longitude}`);

        // Get current date and time for filtering
        const now = new Date();
        const today = new Date(now.setHours(0, 0, 0, 0));
        const currentTime = new Date();

        // Build base query for available duties matching staff role
        const query = {
            status: 'available',
            staffRole: medicalStaff.jobRole,
            date: { $gte: today }
        };

        // Add additional filters
        if (filters.urgency) query.urgency = filters.urgency;
        if (filters.city) {
            const hospitals = await Hospital.find({ city: filters.city }).select('_id');
            query.hospital = { $in: hospitals.map(h => h._id) };
        }

        // Fetch all available duties for this staff's job role — no count cap
        const duties = await Duty.find(query)
            .populate('hospital', 'hospitalLegalName coordinates city state')
            .sort({ date: 1, startTime: 1 });

        console.log(`[AvailableJobs] Total duties fetched from DB: ${duties.length} (role: ${medicalStaff.jobRole})`);

        // --- Step 1: Pre-filter before calling Google Maps ---
        // Remove duties missing hospital coordinates or that have already started
        const validDuties = [];

        for (const duty of duties) {
            if (!duty.hospital?.coordinates?.coordinates) {
                console.log(`[AvailableJobs] Skipping duty ${duty._id} — missing hospital coordinates`);
                continue;
            }

            const dutyDate = new Date(duty.date);
            const dutyDateTime = new Date(dutyDate);

            // Parse start time (format: "HH:MM" or "HH:MM AM/PM")
            const startTimeParts = duty.startTime.match(/(\d+):(\d+)\s*(AM|PM)?/i);
            if (startTimeParts) {
                let hours = parseInt(startTimeParts[1]);
                const minutes = parseInt(startTimeParts[2]);
                const meridiem = startTimeParts[3];

                if (meridiem) {
                    if (meridiem.toUpperCase() === 'PM' && hours !== 12) hours += 12;
                    else if (meridiem.toUpperCase() === 'AM' && hours === 12) hours = 0;
                }

                dutyDateTime.setHours(hours, minutes, 0, 0);
            }

            if (dutyDateTime <= currentTime) {
                console.log(`[AvailableJobs] Skipping duty ${duty._id} — already started at ${duty.startTime} on ${duty.date}`);
                continue;
            }

            validDuties.push(duty);
        }

        console.log(`[AvailableJobs] Valid duties after pre-filter (has coords + not started): ${validDuties.length}`);

        if (validDuties.length === 0) {
            console.log(`[AvailableJobs] No valid duties found — returning empty result`);
            return { jobs: [], staffLocation };
        }

        // --- Step 2: Haversine pre-filter + deduplicate hospitals ---
        // Haversine = straight-line distance (pure JS, no API call)
        // Straight-line is always <= driving distance
        // So if straight-line > 60km → driving is definitely > 50km → skip entirely
        const HAVERSINE_THRESHOLD_KM = 60;
        const nearbyHospitals = new Map();  // hospitalId → { lat, lng } — confirmed nearby
        const skippedHospitals = new Set(); // hospitalId — confirmed too far
        const nearbyDuties = [];
        let haversineSkippedCount = 0;

        for (const duty of validDuties) {
            const hospitalId = duty.hospital._id.toString();

            // Already confirmed far — skip without recalculating
            if (skippedHospitals.has(hospitalId)) {
                haversineSkippedCount++;
                continue;
            }

            // Already confirmed nearby — no recalculation needed
            if (nearbyHospitals.has(hospitalId)) {
                nearbyDuties.push(duty);
                continue;
            }

            // First time seeing this hospital — run haversine check
            const hospitalLat = duty.hospital.coordinates.coordinates.latitude;
            const hospitalLng = duty.hospital.coordinates.coordinates.longitude;
            const straightLine = this.haversineDistance(
                staffLocation.latitude, staffLocation.longitude,
                hospitalLat, hospitalLng
            );

            if (straightLine > HAVERSINE_THRESHOLD_KM) {
                console.log(`[AvailableJobs] Haversine skip: ${duty.hospital.hospitalLegalName} (${duty.hospital.city}) — ${straightLine.toFixed(1)}km straight-line > ${HAVERSINE_THRESHOLD_KM}km threshold`);
                skippedHospitals.add(hospitalId);
                haversineSkippedCount++;
                continue;
            }

            nearbyHospitals.set(hospitalId, { lat: hospitalLat, lng: hospitalLng });
            nearbyDuties.push(duty);
        }

        console.log(`[AvailableJobs] After haversine pre-filter: ${nearbyDuties.length} duties | ${nearbyHospitals.size} unique nearby hospitals | ${haversineSkippedCount} duties skipped`);

        if (nearbyDuties.length === 0) {
            console.log(`[AvailableJobs] No nearby duties — returning empty result`);
            return { jobs: [], staffLocation };
        }

        // --- Step 3: Build destinations — 1 entry per unique hospital (not per duty) ---
        const destinations = Array.from(nearbyHospitals.entries()).map(([id, coords]) => ({
            id,                     // hospitalId as key — result looked up by hospitalId below
            latitude: coords.lat,
            longitude: coords.lng
        }));

        const batchSize = 25;
        const expectedApiCalls = Math.ceil(destinations.length / batchSize);
        console.log(`[AvailableJobs] Google Maps batch call — unique hospitals: ${destinations.length} | duties: ${nearbyDuties.length} | expected API calls: ${expectedApiCalls}`);

        // --- Step 4: Single batch call on unique hospitals only ---
        const { resultMap, totalApiCalls } = await geocodingService.calculateBatchDistanceAndETA(
            staffLocation.latitude,
            staffLocation.longitude,
            destinations
        );

        console.log(`[AvailableJobs] Google Maps API calls made: ${totalApiCalls} | successful results: ${resultMap.size}/${destinations.length}`);

        // --- Step 5: Filter within 50km and build final result ---
        const jobsWithDistance = [];
        let outsideRadiusCount = 0;
        let noResultCount = 0;

        for (const duty of nearbyDuties) {
            const hospitalId = duty.hospital._id.toString();
            const distanceResult = resultMap.get(hospitalId); // lookup by hospitalId

            if (!distanceResult) {
                console.log(`[AvailableJobs] No distance result for hospital ${duty.hospital.hospitalLegalName} — skipping`);
                noResultCount++;
                continue;
            }

            if (distanceResult.distance <= 50) {
                jobsWithDistance.push({
                    ...duty.toObject(),
                    distance: distanceResult.distance,
                    duration: distanceResult.duration,
                    distanceText: distanceResult.distanceText,
                    durationText: distanceResult.durationText
                });
            } else {
                outsideRadiusCount++;
            }
        }

        // Sort by distance (closest first)
        jobsWithDistance.sort((a, b) => a.distance - b.distance);

        console.log(`[AvailableJobs] Summary:`);
        console.log(`  DB fetched            : ${duties.length}`);
        console.log(`  Valid (pre-filter)    : ${validDuties.length}`);
        console.log(`  Haversine skipped     : ${haversineSkippedCount} duties (hospital > ${HAVERSINE_THRESHOLD_KM}km straight-line)`);
        console.log(`  Unique hospitals sent : ${destinations.length}`);
        console.log(`  Within 50km           : ${jobsWithDistance.length}`);
        console.log(`  Outside 50km          : ${outsideRadiusCount}`);
        console.log(`  No API result         : ${noResultCount}`);
        console.log(`  Google Maps calls     : ${totalApiCalls}`);

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