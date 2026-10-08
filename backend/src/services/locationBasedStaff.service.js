const logger = require('../utils/logger');
const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const geocodingService = require('./geocoding.service');
const redisClient = require('../config/redis');
const dashboardService = require('./dashboard.service');
const { URGENCY_LEVELS } = require('../utils/dutyCancellation.constants');
const { hasDutyStarted, istDayRange } = require('../utils/calendar.helper');
const staffLocator = require('./staffLocator.service');
const dutyOfferService = require('./dutyOffer.service');
const blockService = require('./block.service');

class LocationBasedStaffService {
    // Calculate bounding box for 50km radius (in degrees: ~111 km per degree)
    getBoundingBox(lat, lng, radiusKm = 50) {
        return staffLocator.boundingBox(lat, lng, radiusKm);
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



    // Get nearby staff by role with optimized query.
    // radiusKm defaults to 50 (unchanged behavior for new-duty creation);
    // the auto-relist broadcast calls this with a wider radius
    // (RELIST_NOTIFICATION_RADIUS_KM) to reach staff who weren't in range
    // the first time.
    // Verified, available, not suspended staff of a role within radiusKm in a
    // straight line (live position when the app is open, else home address),
    // nearest first. No Maps calls: one per doctor made new-duty posts slow
    // and costly.
    async getNearbyStaffByRole(hospitalCoords, requiredRole, limit = 100, radiusKm = 50, { demo = false } = {}) {
        const cacheKey = `nearby_staff:${demo ? 'demo:' : ''}${requiredRole}:${radiusKm}:${Math.round(hospitalCoords.latitude*1000)}:${Math.round(hospitalCoords.longitude*1000)}`;

        try {
            const redis = await redisClient.getClientAsync();
            const cached = await redis.get(cacheKey);

            if (cached) {
                return JSON.parse(cached);
            }

            const staffWithinRadius = (await staffLocator.findInRadius(hospitalCoords, requiredRole, radiusKm, { demo })).slice(0, limit);

            // Short cache: live positions move
            await redis.setex(cacheKey, 60, JSON.stringify(staffWithinRadius));

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

        logger.debug(`[AvailableJobs] Staff ID: ${staffId} | Job Role: ${medicalStaff.jobRole}`);

        // Get staff current location (browser GPS from Redis, falls back to profile)
        const staffLocation = await this.getStaffCurrentLocation(staffId);
        logger.debug(`[AvailableJobs] Staff location → lat: ${staffLocation.latitude}, lng: ${staffLocation.longitude}`);

        // Widen any staged offers that are due before deciding what this doctor sees
        await dutyOfferService.runDueThrottled();

        // Get current date and time for filtering
        const now = new Date();
        const today = new Date(now.setHours(0, 0, 0, 0));
        const currentTime = new Date();

        // Build base query for available duties matching staff role
        const query = {
            status: 'available',
            staffRole: medicalStaff.jobRole,
            date: { $gte: today },
            // A staff member who cancelled this specific duty can never see
            // or re-accept it again — see autoRelist.service.js guardrail #1.
            'autoRelist.excludedStaff': { $ne: medicalStaff._id },
            isDemo: medicalStaff.isDemo ? true : { $ne: true },
            // Hospitals blocked by or blocking this doctor
            hospital: { $nin: await blockService.hospitalsHiddenFrom(medicalStaff._id) }
        };

        // Calendar day or window (IST dates), never earlier than today
        const fromKey = filters.date || filters.from;
        const toKey = filters.date || filters.to;
        if (fromKey) {
            const fromStart = istDayRange(fromKey, fromKey).$gte;
            query.date.$gte = fromStart > today ? fromStart : today;
        }
        if (toKey) {
            query.date.$lt = istDayRange(toKey, toKey).$lt;
        }

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

        logger.debug(`[AvailableJobs] Total duties fetched from DB: ${duties.length} (role: ${medicalStaff.jobRole})`);

        // --- Step 1: Pre-filter before calling Google Maps ---
        // Remove duties missing hospital coordinates or that have already started
        const validDuties = [];

        for (const duty of duties) {
            if (!duty.hospital?.coordinates?.coordinates) {
                logger.debug(`[AvailableJobs] Skipping duty ${duty._id} — missing hospital coordinates`);
                continue;
            }

            if (hasDutyStarted(duty, currentTime)) {
                logger.debug(`[AvailableJobs] Skipping duty ${duty._id} — already started at ${duty.startTime} on ${duty.date}`);
                continue;
            }

            validDuties.push(duty);
        }

        logger.debug(`[AvailableJobs] Valid duties after pre-filter (has coords + not started): ${validDuties.length}`);

        if (validDuties.length === 0) {
            logger.debug(`[AvailableJobs] No valid duties found — returning empty result`);
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

        // Staged offers are shown by their own rule (current ring, emergency
        // city, or already notified) instead of the fixed 50 km
        const notifiedDuties = await dutyOfferService.notifiedAmong(validDuties, medicalStaff._id);
        const stagedEligible = new Set();

        for (const duty of validDuties) {
            const hospitalId = duty.hospital._id.toString();

            if (dutyOfferService.isStaged(duty)) {
                const { eligible } = dutyOfferService.eligibility(
                    duty.toObject(), medicalStaff, staffLocation, notifiedDuties.has(duty._id.toString())
                );
                if (!eligible) {
                    haversineSkippedCount++;
                    continue;
                }
                stagedEligible.add(duty._id.toString());
                if (!nearbyHospitals.has(hospitalId)) {
                    const coords = duty.hospital.coordinates.coordinates;
                    nearbyHospitals.set(hospitalId, { lat: coords.latitude, lng: coords.longitude });
                }
                nearbyDuties.push(duty);
                continue;
            }

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
                logger.debug(`[AvailableJobs] Haversine skip: ${duty.hospital.hospitalLegalName} (${duty.hospital.city}) — ${straightLine.toFixed(1)}km straight-line > ${HAVERSINE_THRESHOLD_KM}km threshold`);
                skippedHospitals.add(hospitalId);
                haversineSkippedCount++;
                continue;
            }

            nearbyHospitals.set(hospitalId, { lat: hospitalLat, lng: hospitalLng });
            nearbyDuties.push(duty);
        }

        logger.debug(`[AvailableJobs] After haversine pre-filter: ${nearbyDuties.length} duties | ${nearbyHospitals.size} unique nearby hospitals | ${haversineSkippedCount} duties skipped`);

        if (nearbyDuties.length === 0) {
            logger.debug(`[AvailableJobs] No nearby duties — returning empty result`);
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
        logger.debug(`[AvailableJobs] Google Maps batch call — unique hospitals: ${destinations.length} | duties: ${nearbyDuties.length} | expected API calls: ${expectedApiCalls}`);

        // --- Step 4: Single batch call on unique hospitals only ---
        const { resultMap, totalApiCalls } = await geocodingService.calculateBatchDistanceAndETA(
            staffLocation.latitude,
            staffLocation.longitude,
            destinations
        );

        logger.debug(`[AvailableJobs] Google Maps API calls made: ${totalApiCalls} | successful results: ${resultMap.size}/${destinations.length}`);

        // --- Step 5: Filter within 50km and build final result ---
        const jobsWithDistance = [];
        let outsideRadiusCount = 0;
        let noResultCount = 0;

        for (const duty of nearbyDuties) {
            const hospitalId = duty.hospital._id.toString();
            const distanceResult = resultMap.get(hospitalId); // lookup by hospitalId

            if (!distanceResult) {
                logger.debug(`[AvailableJobs] No distance result for hospital ${duty.hospital.hospitalLegalName} — skipping`);
                noResultCount++;
                continue;
            }

            if (distanceResult.distance <= 50 || stagedEligible.has(duty._id.toString())) {
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

        // Sort: urgency first (high before low), relisted duties above
        // same-urgency non-relisted ones, distance as the final tiebreaker
        // ("sort position" — relisted duties rank above duties of
        // the same urgency, behind only a genuinely higher urgency).
        jobsWithDistance.sort((a, b) => {
            const urgencyDiff = URGENCY_LEVELS.indexOf(b.urgency) - URGENCY_LEVELS.indexOf(a.urgency);
            if (urgencyDiff !== 0) return urgencyDiff;

            const aRelisted = (a.autoRelist?.relistCount || 0) > 0 ? 1 : 0;
            const bRelisted = (b.autoRelist?.relistCount || 0) > 0 ? 1 : 0;
            if (aRelisted !== bRelisted) return bRelisted - aRelisted;

            return a.distance - b.distance;
        });

        logger.debug(`[AvailableJobs] Summary:`);
        logger.debug(`  DB fetched            : ${duties.length}`);
        logger.debug(`  Valid (pre-filter)    : ${validDuties.length}`);
        logger.debug(`  Haversine skipped     : ${haversineSkippedCount} duties (hospital > ${HAVERSINE_THRESHOLD_KM}km straight-line)`);
        logger.debug(`  Unique hospitals sent : ${destinations.length}`);
        logger.debug(`  Within 50km           : ${jobsWithDistance.length}`);
        logger.debug(`  Outside 50km          : ${outsideRadiusCount}`);
        logger.debug(`  No API result         : ${noResultCount}`);
        logger.debug(`  Google Maps calls     : ${totalApiCalls}`);

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