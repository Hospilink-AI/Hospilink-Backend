// One duty's detail, for whoever is allowed to see it
// Methods of DutyService; mixed into the class in ../duty.service.js, so `this` is the service.
const logger = require('../../utils/logger');
const Duty = require('../../models/Duty');
const Hospital = require('../../models/Hospital');
const MedicalStaff = require('../../models/MedicalStaff');
const geocodingService = require('../geocoding.service');
const DashboardService = require('../dashboard.service');
const reviewService = require('../review.service');
const dutyOfferService = require('../dutyOffer.service');
const { NotFoundError, ForbiddenError } = require('../../middleware/error.middleware');

module.exports = {
    async getDutyDetail(dutyId, userId, userRole) {
        // Find the duty with comprehensive population
        let duty = await Duty.findById(dutyId)
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email phone'
                }
            })
            .populate({
                path: 'assignedTo',
                populate: {
                    path: 'user',
                    select: 'name email phone'
                }
            })
            .populate('statusHistory.changedBy', 'name email role');

        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        // Blind/simultaneous reveal (Phase 3) — computed once, used at
        // every exit path below instead of each doing its own ambiguous
        // Review.findOne({ duty: dutyId }) (that had no reviewType filter,
        // so which of up to two reviews came back was non-deterministic).
        const visibleReviews = await reviewService.getVisibleReviewsForDuty(dutyId, userRole);
        const myReview = userRole === 'staff' ? visibleReviews.staffToHospital
            : userRole === 'hospital' ? visibleReviews.hospitalToStaff
            : null;

        // Role-based authorization
        logger.debug(`getDutyDetail called with userRole: "${userRole}" for duty ${dutyId}`);
        if (userRole === 'staff') {
            logger.debug('Entering staff block - distance calculation will be performed');
            // Find medical staff profile
            const medicalStaff = await MedicalStaff.findOne({ user: userId });
            if (!medicalStaff) {
                throw new NotFoundError('Medical staff profile not found');
            }

            // Staff can view available duties OR duties assigned to them.
            // A staff member excluded from this duty (they cancelled it
            // earlier — see autoRelist.excludedStaff) can't view it as
            // "available" either, even though the duty itself still is.
            const isAssigned = duty.assignedTo && duty.assignedTo._id.toString() === medicalStaff._id.toString();
            const isExcludedFromRelist = (duty.autoRelist?.excludedStaff || [])
                .some(id => id.toString() === medicalStaff._id.toString());
            const isAvailable = duty.status === 'available' && !isExcludedFromRelist;

            // Also check that duty is not expired
            const isExpired = duty.status === 'expired';

            if (!isAssigned && !isAvailable) {
                throw new ForbiddenError('Access denied: You can only view available duties or duties assigned to you');
            }

            if (!isAssigned && !(await dutyOfferService.isEligible(duty, medicalStaff))) {
                throw new ForbiddenError('Access denied: This duty has not been offered to you yet');
            }

            if (isExpired) {
                throw new ForbiddenError('Access denied: This duty has expired and is no longer available');
            }

            // Same deadline the feed shows
            const offerExpiresAt = isAvailable ? dutyOfferService.offerExpiresAt(duty) : null;

            // Counts towards "viewed by N" on the hospital's fill tracker
            if (isAvailable) {
                Duty.updateOne({ _id: duty._id }, { $addToSet: { viewedBy: medicalStaff._id } })
                    .catch(err => console.error('Failed to record duty view:', err));
            }

            // Add distance information for staff members only (always show distance)
            try {
                // Get staff real-time location with fallback to profile
                const locationInfo = await DashboardService.getStaffLocationForDuties(userId);
                const staffLat = locationInfo.location.latitude;
                const staffLng = locationInfo.location.longitude;
                const locationSource = locationInfo.source; // 'browser' or 'profile'

                logger.debug(`Staff accessing duty ${duty._id} - using ${locationSource} location:`, {
                    lat: staffLat,
                    lng: staffLng,
                    permissionGranted: locationInfo.permissionGranted
                });

                // Check if hospital has coordinates
                if (duty.hospital.coordinates &&
                    duty.hospital.coordinates.coordinates &&
                    duty.hospital.coordinates.coordinates.latitude &&
                    duty.hospital.coordinates.coordinates.longitude) {

                    const hospitalLat = duty.hospital.coordinates.coordinates.latitude;
                    const hospitalLng = duty.hospital.coordinates.coordinates.longitude;

                    logger.debug(`Processing distance for duty ${duty._id}:`, {
                        staffLocation: { lat: staffLat, lng: staffLng },
                        hospitalLocation: { lat: hospitalLat, lng: hospitalLng },
                        hospitalName: duty.hospital.hospitalLegalName,
                        locationSource: locationSource
                    });

                    try {
                        // Calculate distance and ETA using Google Maps API (with Haversine fallback)
                        const distanceInfo = await geocodingService.calculateDistanceAndETA(
                            staffLat, staffLng, hospitalLat, hospitalLng
                        );

                        logger.debug(`Distance calculation completed for duty ${duty._id}:`, {
                            method: distanceInfo.source,
                            distance: distanceInfo.distanceText,
                            duration: distanceInfo.durationText,
                            locationSource: locationSource
                        });

                        // Convert duty to plain object and add distance information
                        const dutyObject = duty.toObject();
                        dutyObject.offerExpiresAt = offerExpiresAt;
                        dutyObject.distance = distanceInfo.distance;
                        dutyObject.duration = distanceInfo.duration;
                        dutyObject.distanceText = distanceInfo.distanceText;
                        dutyObject.durationText = distanceInfo.durationText;
                        dutyObject.staffLocationSource = locationSource; // Add location source info
                        dutyObject.hospitalLocation = {
                            latitude: hospitalLat,
                            longitude: hospitalLng,
                            address: {
                                currentAddress: duty.hospital.currentAddress,
                                city: duty.hospital.city,
                                state: duty.hospital.state,
                                pincode: duty.hospital.pincode
                            }
                        };

                        // Add review data before returning
                        dutyObject.review = myReview;
                        dutyObject.hospitalReview = visibleReviews.hospitalToStaff;
                        dutyObject.staffReview = visibleReviews.staffToHospital;

                        return dutyObject;
                    } catch (distanceError) {
                        console.error(`Distance calculation failed for duty ${duty._id}:`, distanceError.message);

                        // Add review data even if distance calculation fails
                        const dutyObject = duty.toObject();
                        dutyObject.offerExpiresAt = offerExpiresAt;
                        dutyObject.review = myReview;
                        dutyObject.hospitalReview = visibleReviews.hospitalToStaff;
                        dutyObject.staffReview = visibleReviews.staffToHospital;

                        return dutyObject;
                    }
                } else {
                    console.warn(`Hospital coordinates missing for duty ${duty._id}:`, {
                        hospitalId: duty.hospital._id,
                        coordinates: duty.hospital.coordinates
                    });

                    // Still add review data even without coordinates
                    const dutyObject = duty.toObject();
                    dutyObject.offerExpiresAt = offerExpiresAt;
                    dutyObject.review = myReview;
                    dutyObject.hospitalReview = visibleReviews.hospitalToStaff;
                    dutyObject.staffReview = visibleReviews.staffToHospital;

                    return dutyObject;
                }
            } catch (error) {
                console.error(`Distance calculation failed for duty ${duty._id}:`, error.message);

                // Add review data even if distance calculation fails
                const dutyObject = duty.toObject();
                dutyObject.offerExpiresAt = offerExpiresAt;
                dutyObject.review = myReview;
                dutyObject.hospitalReview = visibleReviews.hospitalToStaff;
                dutyObject.staffReview = visibleReviews.staffToHospital;

                return dutyObject;
            }
        } else if (userRole === 'hospital') {
            logger.debug('Entering hospital block - CONDITIONAL distance calculation');
            // Find hospital profile
            const hospital = await Hospital.findOne({ user: userId });
            if (!hospital) {
                throw new NotFoundError('Hospital profile not found');
            }

            // Hospital can only view their own duties
            if (duty.hospital._id.toString() !== hospital._id.toString()) {
                throw new ForbiddenError('Access denied: You can only view your hospital duties');
            }

            // Add distance/time ONLY when duty is assigned (accepted by staff)
            const shouldShowDistance = duty.status === 'assigned' ||
                duty.status === 'enroute' ||
                duty.status === 'in-progress';

            if (shouldShowDistance && duty.assignedTo && duty.assignedTo.user) {
                try {
                    logger.debug(`Hospital viewing assigned duty ${duty._id} - calculating staff distance`);

                    // Get assigned staff's real-time location
                    const locationInfo = await DashboardService.getStaffLocationForDuties(duty.assignedTo.user._id);
                    const staffLat = locationInfo.location.latitude;
                    const staffLng = locationInfo.location.longitude;
                    const locationSource = locationInfo.source;

                    // Get hospital coordinates
                    const hospitalLat = duty.hospital.coordinates.coordinates.latitude;
                    const hospitalLng = duty.hospital.coordinates.coordinates.longitude;

                    // Calculate distance and time
                    const distanceInfo = await geocodingService.calculateDistanceAndETA(
                        staffLat, staffLng, hospitalLat, hospitalLng
                    );

                    logger.debug(`Hospital distance calculated for duty ${duty._id}:`, {
                        distance: distanceInfo.distanceText,
                        duration: distanceInfo.durationText,
                        staffLocationSource: locationSource
                    });

                    // Add distance info to duty object
                    const dutyObject = duty.toObject();
                    dutyObject.distance = distanceInfo.distance;
                    dutyObject.duration = distanceInfo.duration;
                    dutyObject.distanceText = distanceInfo.distanceText;
                    dutyObject.durationText = distanceInfo.durationText;
                    dutyObject.staffLocationSource = locationSource;
                    dutyObject.hospitalLocation = {
                        latitude: hospitalLat,
                        longitude: hospitalLng,
                        address: {
                            currentAddress: duty.hospital.currentAddress,
                            city: duty.hospital.city,
                            state: duty.hospital.state,
                            pincode: duty.hospital.pincode
                        }
                    };

                    // Add review data
                    dutyObject.review = myReview;
                    dutyObject.hospitalReview = visibleReviews.hospitalToStaff;
                    dutyObject.staffReview = visibleReviews.staffToHospital;

                    return dutyObject;
                } catch (distanceError) {
                    console.error(`Hospital distance calculation failed for duty ${duty._id}:`, distanceError.message);
                }
            }

            logger.debug(`Hospital viewing duty ${duty._id} - no distance calculation (status: ${duty.status})`);
        } else if (userRole === 'admin') {
            // Admin can view any duty — fall through to return below
        } else {
            throw new ForbiddenError('Access denied: insufficient role to view duty details');
        }

        // For hospital users (or when distance calculation fails), add review data and return
        const dutyObject = duty.toObject();

        // Add review data for hospital users
        dutyObject.review = myReview;
        dutyObject.hospitalReview = visibleReviews.hospitalToStaff;
        dutyObject.staffReview = visibleReviews.staffToHospital;

        return dutyObject;
    }
};
