// Duties as a doctor sees them: upcoming, ongoing, available offers with
// distances, and the route to a duty
// Methods of DutyService; mixed into the class in ../duty.service.js, so `this` is the service.
const logger = require('../../utils/logger');
const Duty = require('../../models/Duty');
const MedicalStaff = require('../../models/MedicalStaff');
const { toIST, getCurrentIST } = require('../../utils/helpers');
const geocodingService = require('../geocoding.service');
const DashboardService = require('../dashboard.service');
const { AppError, ValidationError, NotFoundError } = require('../../middleware/error.middleware');

module.exports = {
    async getUpcomingDutiesForStaff(userId) {
        // Find the medical staff profile for this user
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            return []; // Return empty array if no profile found
        }

        // Get current date and time
        const now = getCurrentIST();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Find duties assigned to this staff member that are in the future or happening today
        const duties = await Duty.find({
            assignedTo: medicalStaff._id,
            status: 'assigned',
            $or: [
                { date: { $gt: today } }, // Future dates
                {
                    date: today, // Today's duties
                },
                {
                    // Overnight duties that end today or in the future
                    endDate: { $gte: today }
                }
            ]
        })
            .populate('hospital', 'hospitalLegalName currentAddress city state pincode coordinates')
            .sort({ date: 1, startTime: 1 }); // Sort by date and start time

        // Filter out duties that have already ended today
        const upcomingDuties = duties.filter(duty => {
            const dutyStartDate = new Date(duty.date);

            // For overnight duties, check if the end time on end date hasn't passed
            if (duty.isOvernightDuty && duty.endDate) {
                const dutyEndTime = toIST(new Date(`${duty.endDate.toISOString().split('T')[0]}T${duty.endTime}`));
                return dutyEndTime > now;
            }

            // If it's a future date, include it
            if (dutyStartDate > today) {
                return true;
            }

            // If it's today, check if the end time hasn't passed
            if (dutyStartDate.toDateString() === today.toDateString()) {
                const dutyEndTime = toIST(new Date(`${duty.date.toISOString().split('T')[0]}T${duty.endTime}`));
                return dutyEndTime > now;
            }

            return false;
        });

        // Get staff location using dashboard service
        let staffLat, staffLng;
        let locationSource = 'profile';

        try {
            const locationInfo = await DashboardService.getStaffLocationForDuties(userId);
            staffLat = locationInfo.location.latitude;
            staffLng = locationInfo.location.longitude;
            locationSource = locationInfo.source;
        } catch (error) {
            console.error('Failed to get staff location for upcoming duties:', error.message);
            // Return duties without distance if no location available
            return upcomingDuties;
        }

        logger.debug(`[UpcomingDuties] Using ${locationSource} location for staff ${userId}: lat=${staffLat}, lng=${staffLng}`);

        // --- Step 1: Separate duties with and without coordinates ---
        const dutiesWithCoords = [];
        const dutiesWithoutCoords = [];

        for (const duty of upcomingDuties) {
            if (
                duty.hospital?.coordinates?.coordinates?.latitude &&
                duty.hospital?.coordinates?.coordinates?.longitude
            ) {
                dutiesWithCoords.push(duty);
            } else {
                dutiesWithoutCoords.push(duty);
            }
        }

        logger.debug(`[UpcomingDuties] Duties with coordinates: ${dutiesWithCoords.length} | Without coordinates: ${dutiesWithoutCoords.length}`);

        // --- Step 2: Build destinations array for batch call ---
        const destinations = dutiesWithCoords.map(duty => ({
            id: duty._id.toString(),
            latitude: duty.hospital.coordinates.coordinates.latitude,
            longitude: duty.hospital.coordinates.coordinates.longitude
        }));

        const batchSize = 25;
        const expectedApiCalls = Math.ceil(destinations.length / batchSize);
        logger.debug(`[UpcomingDuties] Google Maps batch call — destinations: ${destinations.length} | batch size: ${batchSize} | expected API calls: ${expectedApiCalls}`);

        // --- Step 3: Single batch call instead of N individual calls ---
        let resultMap = new Map();
        let totalApiCalls = 0;

        try {
            ({ resultMap, totalApiCalls } = await geocodingService.calculateBatchDistanceAndETA(
                staffLat, staffLng, destinations
            ));
            logger.debug(`[UpcomingDuties] Google Maps API calls made: ${totalApiCalls} | successful results: ${resultMap.size}/${destinations.length}`);
        } catch (error) {
            console.error(`[UpcomingDuties] Batch distance calculation failed: ${error.message}`);
        }

        // --- Step 4: Build final result ---
        const dutiesWithDistance = [];

        // Duties that had coordinates — attach distance from resultMap
        for (const duty of dutiesWithCoords) {
            const distanceResult = resultMap.get(duty._id.toString());
            dutiesWithDistance.push({
                ...duty.toObject(),
                distance: distanceResult?.distance ?? null,
                duration: distanceResult?.duration ?? null,
                distanceText: distanceResult?.distanceText ?? 'Distance unavailable',
                durationText: distanceResult?.durationText ?? 'ETA unavailable'
            });
        }

        // Duties that had no coordinates — attach nulls
        for (const duty of dutiesWithoutCoords) {
            dutiesWithDistance.push({
                ...duty.toObject(),
                distance: null,
                duration: null,
                distanceText: 'Distance unavailable',
                durationText: 'ETA unavailable'
            });
        }

        // Sort by date and startTime (earliest first)
        dutiesWithDistance.sort((a, b) => {
            const dateCompare = new Date(a.date) - new Date(b.date);
            if (dateCompare !== 0) return dateCompare;
            return a.startTime.localeCompare(b.startTime);
        });

        logger.debug(`[UpcomingDuties] ✓ Summary:`);
        logger.debug(`  DB fetched           : ${duties.length}`);
        logger.debug(`  After time filter    : ${upcomingDuties.length}`);
        logger.debug(`  With coordinates     : ${dutiesWithCoords.length}`);
        logger.debug(`  Without coordinates  : ${dutiesWithoutCoords.length}`);
        logger.debug(`  Google Maps calls    : ${totalApiCalls}`);

        return dutiesWithDistance;
    },

    async getOngoingDutiesForStaff(userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found');
        }

        const duties = await Duty.find({
            assignedTo: medicalStaff._id,
            status: { $in: ['enroute', 'in-progress'] }
        })
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .sort({ date: 1, startTime: 1 });

        return duties;
    },

    // Get available jobs with distance calculation for staff member
    async getAvailableJobsWithDistance(staffId, filters = {}) {
        try {
            // Get staff location using new dashboard service
            const locationInfo = await DashboardService.getStaffLocationForDuties(staffId);

            const staffLat = locationInfo.location.latitude;
            const staffLng = locationInfo.location.longitude;
            const locationSource = locationInfo.source;

            logger.debug(`Using ${locationSource} location for staff ${staffId}:`, {
                lat: staffLat,
                lng: staffLng,
                permissionGranted: locationInfo.permissionGranted
            });

            // Get staff information for role filtering
            const staff = await MedicalStaff.findOne({ user: staffId });
            if (!staff) {
                throw new NotFoundError('Staff profile not found');
            }

            logger.debug(`Processing available duties for staff ${staffId}:`, {
                staffLocation: { lat: staffLat, lng: staffLng },
                staffRole: staff.jobRole,
                locationSource: locationSource
            });

            // Build query for available duties
            let query = {
                status: { $in: ['available'] },
                staffRole: staff.jobRole
            };

            // Add optional filters
            if (filters.date) {
                query.date = {
                    $gte: new Date(filters.date),
                    $lt: new Date(filters.date).setDate(new Date(filters.date).getDate() + 1)
                };
            }

            if (filters.urgency) {
                query.urgency = filters.urgency;
            }

            // Get available duties
            const duties = await Duty.find(query)
                .populate('hospital', 'hospitalLegalName currentAddress city state pincode location coordinates')
                .sort({ date: 1, startTime: 1 });

            // Additional safety filter to ensure no expired duties
            const filteredDuties = duties.filter(duty => duty.status === 'available');

            logger.debug(`Found ${filteredDuties.length} available duties for staff ${staffId} (filtered from ${duties.length} total)`);


            // Calculate distance for each duty
            const jobsWithDistance = [];

            for (const duty of filteredDuties) {
                // Check for named coordinates structure
                if (!duty.hospital.coordinates ||
                    !duty.hospital.coordinates.coordinates ||
                    !duty.hospital.coordinates.coordinates.latitude ||
                    !duty.hospital.coordinates.coordinates.longitude) {
                    console.warn(`Hospital coordinates missing for duty ${duty._id}:`, {
                        hospitalId: duty.hospital._id,
                        hospitalName: duty.hospital.hospitalLegalName,
                        coordinates: duty.hospital.coordinates
                    });
                    continue;
                }

                // Access named coordinates
                const hospitalLat = duty.hospital.coordinates.coordinates.latitude;
                const hospitalLng = duty.hospital.coordinates.coordinates.longitude;

                logger.debug(`Calculating distance for duty ${duty._id}:`, {
                    hospitalName: duty.hospital.hospitalLegalName,
                    staffLocation: { lat: staffLat, lng: staffLng },
                    hospitalLocation: { lat: hospitalLat, lng: hospitalLng }
                });

                try {
                    // Calculate distance and ETA using Google Maps API (with Haversine fallback)
                    const distanceInfo = await geocodingService.calculateDistanceAndETA(
                        staffLat, staffLng, hospitalLat, hospitalLng
                    );

                    logger.debug(`Distance calculation completed for duty ${duty._id}:`, {
                        method: distanceInfo.source,
                        distance: distanceInfo.distanceText,
                        duration: distanceInfo.durationText
                    });

                    const jobWithDistance = {
                        ...duty.toObject(),
                        distance: distanceInfo.distance,
                        duration: distanceInfo.duration,
                        distanceText: distanceInfo.distanceText,
                        durationText: distanceInfo.durationText,
                    };

                    jobsWithDistance.push(jobWithDistance);
                } catch (error) {
                    console.error(`Distance calculation failed for duty ${duty._id}:`, error.message);

                    continue;
                }
            }

            // Sort by distance (closest first)
            jobsWithDistance.sort((a, b) => a.distance - b.distance);

            logger.debug(`Processed ${jobsWithDistance.length} duties with distance information`);

            return {
                success: true,
                jobs: jobsWithDistance,
                staffLocation: {
                    latitude: staffLat,
                    longitude: staffLng,
                    source: locationSource // 'browser' or 'profile'
                },
                totalJobs: jobsWithDistance.length
            };
        } catch (error) {
            console.error('Error in getAvailableJobsWithDistance:', error.message);
            throw error;
        }
    },

    async getJobRouteInfo(dutyId, staffId, currentLocation) {
        // Get duty details
        const duty = await Duty.findById(dutyId).populate('hospital', 'hospitalLegalName currentAddress city state pincode coordinates');

        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        // Add proper null check before accessing location properties
        if (!currentLocation || !currentLocation.latitude || !currentLocation.longitude) {
            throw new ValidationError('Staff location is required to get route information. Please enable location in your dashboard or update your profile location.');
        }

        const staffLat = currentLocation.latitude;
        const staffLng = currentLocation.longitude;

        // Check for named coordinates structure
        if (!duty.hospital.coordinates ||
            !duty.hospital.coordinates.coordinates ||
            !duty.hospital.coordinates.coordinates.latitude ||
            !duty.hospital.coordinates.coordinates.longitude) {

            throw new NotFoundError('Hospital location not found');
        }

        //  Access named coordinates
        const hospitalLat = duty.hospital.coordinates.coordinates.latitude;
        const hospitalLng = duty.hospital.coordinates.coordinates.longitude;

        try {
            // Get detailed route using Google Maps Directions API
            const routeInfo = await geocodingService.getDirections(
                staffLat, staffLng, hospitalLat, hospitalLng
            );
            return {
                success: true,
                job: {
                    id: duty._id,
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    urgency: duty.urgency,
                    description: duty.description,
                    offeredRate: duty.offeredRate
                },
                hospital: {
                    id: duty.hospital._id,
                    name: duty.hospital.hospitalLegalName,
                    address: duty.hospital.currentAddress,
                    city: duty.hospital.city,
                    state: duty.hospital.state,
                    pincode: duty.hospital.pincode,
                    location: {
                        latitude: hospitalLat,
                        longitude: hospitalLng
                    }
                },
                staffLocation: {
                    latitude: staffLat,
                    longitude: staffLng

                },

                route: {
                    overviewPolyline: routeInfo.overviewPolyline,
                    stepPolylines: routeInfo.stepPolylines,
                    distance: routeInfo.distance,
                    duration: routeInfo.duration,
                    distanceText: routeInfo.distanceText,
                    durationText: routeInfo.durationText,
                    steps: routeInfo.steps
                }
            };
        } catch (error) {
            console.error('Directions API failed:', error.message);
            throw new AppError('Unable to get route information. Please try again.', 503);
        }
    }
};
