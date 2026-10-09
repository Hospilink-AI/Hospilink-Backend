// Duties as hospitals and admins see them: active and past lists, status
// history, route maps, the emergency dashboard and auto-relist panels
// Methods of DutyService; mixed into the class in ../duty.service.js, so `this` is the service.
const Duty = require('../../models/Duty');
const Hospital = require('../../models/Hospital');
const MedicalStaff = require('../../models/MedicalStaff');
const {
    toIST,
    getCurrentIST,
    calculateDutyDuration,
    formatDuration
} = require('../../utils/helpers');
const geocodingService = require('../geocoding.service');
const { getPaginationParams, getPaginationMeta } = require('../../utils/pagination');
const { ALLOWED_ROLES } = require('../../utils/constants');
const redisClient = require('../../config/redis');
const { getBatchStaffLocations, formatActiveDuty } = require('../../utils/activeDuty.helper');
const s3Service = require('../s3.service');
const ratingAlgorithmService = require('../ratingAlgorithm.service');
const systemConfigService = require('../systemConfig.service');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../middleware/error.middleware');

module.exports = {
    // Active duties for hospital — shows only available, assigned, enroute, in-progress statuses
    async getActiveDuties({ hospitalUserId, date, startDate, endDate, status, staffRole, page = 1, limit = 10 }) {
        const { skip } = getPaginationParams(page, limit);

        const hospital = await Hospital.findOne({ user: hospitalUserId });
        if (!hospital) return { duties: [], pagination: getPaginationMeta(0, page, limit) };

        const match = { hospital: hospital._id };

        // Single date filter
        if (date) {
            const d = new Date(date);
            const next = new Date(d);
            next.setDate(next.getDate() + 1);
            match.date = { $gte: d, $lt: next };
            // Date range filter
        } else if (startDate || endDate) {
            match.date = {};
            if (startDate) match.date.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setDate(end.getDate() + 1);
                match.date.$lt = end;
            }
        }

        // Only show active statuses for duties-published endpoint
        const activeStatuses = ['available', 'assigned', 'enroute', 'in-progress'];
        if (status) {
            // If status is provided, validate it's one of the active statuses
            if (!activeStatuses.includes(status)) {
                throw new ValidationError('Invalid status. Only available, assigned, enroute, in-progress are allowed');
            }
            match.status = status;
        } else {
            // Default to showing only active statuses
            match.status = { $in: activeStatuses };
        }

        if (staffRole) match.staffRole = staffRole;

        const [duties, total] = await Promise.all([
            Duty.find(match)
                .populate({
                    path: 'assignedTo',
                    select: 'fullName averageRating totalRatings',
                    populate: { path: 'user', select: 'name email' }
                })
                .select('staffRole startTime endTime date isOvernightDuty endDate status assignedTo totalPayment offeredRate')
                .sort({ date: -1, startTime: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            Duty.countDocuments(match)
        ]);

        // Batched, not one call per row — see
        // ratingAlgorithm.service.js#getEffectiveRatingsForMany. Keyed by
        // MedicalStaff _id (not positional index) since duty.assignedTo can
        // be null and we don't want a null to shift later rows' ratings.
        const assignedStaff = duties.map(d => d.assignedTo).filter(Boolean);
        const effectiveRatingsList = await ratingAlgorithmService.getEffectiveRatingsForMany(assignedStaff, 'hospital_to_staff');
        const effectiveRatingByStaffId = new Map(assignedStaff.map((s, i) => [s._id.toString(), effectiveRatingsList[i].ratingShown]));

        const formatted = duties.map(duty => {
            const staff = duty.assignedTo;
            const hoursCompleted = calculateDutyDuration(
                duty.date, duty.startTime, duty.endTime,
                duty.isOvernightDuty, duty.endDate
            );

            // Format hours label e.g. "8 Hours" or "1.5 Hours"
            const hoursLabel = hoursCompleted === 1
                ? '1 Hour'
                : `${Number.isInteger(hoursCompleted) ? hoursCompleted : hoursCompleted.toFixed(1)} Hours`;

            return {
                dutyId: duty._id,
                staff: staff ? {
                    name: staff.fullName || staff.user?.name || '—',
                    email: staff.user?.email || '—',
                    averageRating: staff.averageRating ?? 0,
                    totalRatings: staff.totalRatings ?? 0,
                    effectiveRating: effectiveRatingByStaffId.get(staff._id.toString()) ?? null
                } : null,
                staffRole: duty.staffRole,
                shiftDuration: `${duty.startTime} - ${duty.endTime}`,
                hoursCompleted: hoursLabel,
                status: duty.status,
                offeredRate: duty.offeredRate,
                totalPayment: duty.totalPayment,
                date: duty.date
            };
        });

        return {
            duties: formatted,
            pagination: getPaginationMeta(total, parseInt(page), parseInt(limit))
        };
    },

    // Duty history for hospital — shows only completed, cancelled, expired, incomplete statuses
    async getDutyHistory({ hospitalUserId, date, startDate, endDate, status, staffRole, page = 1, limit = 10 }) {
        const { skip } = getPaginationParams(page, limit);

        const hospital = await Hospital.findOne({ user: hospitalUserId });
        if (!hospital) return { duties: [], pagination: getPaginationMeta(0, page, limit) };

        const match = { hospital: hospital._id };

        // Single date filter
        if (date) {
            const d = new Date(date);
            const next = new Date(d);
            next.setDate(next.getDate() + 1);
            match.date = { $gte: d, $lt: next };
            // Date range filter
        } else if (startDate || endDate) {
            match.date = {};
            if (startDate) match.date.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setDate(end.getDate() + 1);
                match.date.$lt = end;
            }
        }

        // Only show historical statuses for duties-history endpoint
        const historicalStatuses = ['completed', 'cancelled', 'expired', 'incomplete'];
        if (status) {
            // If status is provided, validate it's one of the historical statuses
            if (!historicalStatuses.includes(status)) {
                throw new ValidationError('Invalid status. Only completed, cancelled, expired, incomplete are allowed');
            }
            match.status = status;
        } else {
            // Default to showing only historical statuses
            match.status = { $in: historicalStatuses };
        }

        if (staffRole) match.staffRole = staffRole;

        const [duties, total] = await Promise.all([
            Duty.find(match)
                .populate({
                    path: 'assignedTo',
                    select: 'fullName averageRating totalRatings profilePicture.s3Key',
                    populate: { path: 'user', select: 'name email' }
                })
                .select('staffRole startTime endTime date isOvernightDuty endDate status assignedTo totalPayment offeredRate completedAt cancelledAt expiredAt incompleteAt cancellation')
                .sort({ completedAt: -1, cancelledAt: -1, expiredAt: -1, incompleteAt: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            Duty.countDocuments(match)
        ]);

        // Batched, not one call per row — see
        // ratingAlgorithm.service.js#getEffectiveRatingsForMany. Keyed by
        // MedicalStaff _id (not positional index) since duty.assignedTo can
        // be null and we don't want a null to shift later rows' ratings.
        const assignedStaff = duties.map(d => d.assignedTo).filter(Boolean);
        const effectiveRatingsList = await ratingAlgorithmService.getEffectiveRatingsForMany(assignedStaff, 'hospital_to_staff');
        const effectiveRatingByStaffId = new Map(assignedStaff.map((s, i) => [s._id.toString(), effectiveRatingsList[i].ratingShown]));

        const formatted = await Promise.all(duties.map(async (duty) => {
            const staff = duty.assignedTo;
            const hoursCompleted = calculateDutyDuration(
                duty.date, duty.startTime, duty.endTime,
                duty.isOvernightDuty, duty.endDate
            );

            // Format duration using formatDuration helper 
            const hoursLabel = formatDuration(hoursCompleted);

            // Get the relevant timestamp based on status
            const statusTimestamp = duty.completedAt || duty.cancelledAt || duty.expiredAt || duty.incompleteAt;

            // Generate presigned URL for profile picture if s3Key exists
            let profilePictureUrl = null;
            if (staff?.profilePicture?.s3Key) {
                try {
                    profilePictureUrl = await s3Service.generatePreSignedURL(staff.profilePicture.s3Key);
                } catch (error) {
                    console.error('Error generating presigned URL for profile picture:', error);
                    profilePictureUrl = null;
                }
            }

            return {
                dutyId: duty._id,
                staff: staff ? {
                    name: staff.fullName || staff.user?.name || '—',
                    email: staff.user?.email || '—',
                    averageRating: staff.averageRating ?? 0,
                    totalRatings: staff.totalRatings ?? 0,
                    effectiveRating: effectiveRatingByStaffId.get(staff._id.toString()) ?? null,
                    profilePicture: profilePictureUrl
                } : null,
                staffRole: duty.staffRole,
                shiftDuration: `${duty.startTime} - ${duty.endTime}`,
                hoursCompleted: hoursLabel,
                status: duty.status,
                offeredRate: duty.offeredRate,
                totalPayment: duty.totalPayment,
                date: duty.date,
                statusTimestamp: statusTimestamp,
                cancellation: duty.cancellation || null
            };
        }));

        return {
            duties: formatted,
            pagination: getPaginationMeta(total, parseInt(page), parseInt(limit))
        };
    },

    async getDutyStatusHistory(dutyId, userId, userRole) {
        // Find the medical staff profile for this user (if staff)
        const medicalStaff = await MedicalStaff.findOne({ user: userId });

        const duty = await Duty.findById(dutyId)
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .populate({
                path: 'statusHistory.changedBy',
                select: 'name email role'
            });

        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        // Authorization check
        if (userRole === 'staff') {
            if (!medicalStaff) {
                throw new NotFoundError('Medical staff profile not found');
            }
            if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
                throw new ForbiddenError('You can only view status history for duties assigned to you');
            }
        } else if (userRole === 'hospital') {
            const hospital = await Hospital.findOne({ user: userId });
            if (!hospital || duty.hospital._id.toString() !== hospital._id.toString()) {
                throw new ForbiddenError('You can only view status history for your own duties');
            }
        }

        return {
            duty: {
                id: duty._id,
                staffRole: duty.staffRole,
                date: duty.date,
                startTime: duty.startTime,
                endTime: duty.endTime,
                currentStatus: duty.status
            },
            statusHistory: duty.statusHistory.sort((a, b) => b.timestamp - a.timestamp)
        };
    },

    // "Finding cover" panel — this hospital's relisted duties,
    // soonest start first, with the plain-words `state` the spec calls for
    // (never internal terms like relistCount/status directly).
    async getFindingCoverPanel(hospitalUserId) {
        const hospital = await Hospital.findOne({ user: hospitalUserId });
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found');
        }

        const relistCap = await systemConfigService.getEffective('autoRelist.relistCap');

        const duties = await Duty.find({
            hospital: hospital._id,
            'autoRelist.relistCount': { $gt: 0 },
            status: { $in: ['available', 'assigned', 'expired'] }
        })
            .select('staffRole date startTime endTime status urgency offeredRate autoRelist')
            .sort({ date: 1, startTime: 1 })
            .lean();

        return duties.map(duty => {
            const relist = duty.autoRelist || {};
            const history = relist.history || [];
            const lastEntry = history[history.length - 1] || null;

            let state;
            if (duty.status === 'expired') {
                state = 'not_covered';
            } else if (duty.status === 'assigned') {
                state = 'covered';
            } else if ((relist.relistCount || 0) >= relistCap) {
                state = 'needs_your_input';
            } else {
                state = 'finding_cover';
            }

            return {
                dutyId: duty._id,
                staffRole: duty.staffRole,
                date: duty.date,
                startTime: duty.startTime,
                endTime: duty.endTime,
                relistCount: relist.relistCount || 0,
                lastCancelledAt: lastEntry?.timestamp || null,
                reason: lastEntry?.reason || null,
                reasonText: lastEntry?.reasonText || null,
                urgency: duty.urgency,
                originalUrgency: lastEntry?.urgencyBefore || null,
                rate: duty.offeredRate,
                originalRate: relist.originalOfferedRate ?? null,
                rateBoosted: !!relist.rateBoostApplied,
                state
            };
        });
    },

    // Spec §07 hospital month-to-date line: duties relisted / re-filled /
    // extra amount actually paid. "Actually paid" means the boosted
    // duty was taken, not merely offered — an expired boosted duty costs
    // the hospital nothing, so it's excluded from extraPaid.
    async getAutoRelistMonthToDate(hospitalUserId) {
        const hospital = await Hospital.findOne({ user: hospitalUserId });
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found');
        }

        const now = getCurrentIST();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const duties = await Duty.find({
            hospital: hospital._id,
            'autoRelist.history.timestamp': { $gte: monthStart }
        }).select('status offeredRate autoRelist').lean();

        let dutiesRelisted = 0;
        let dutiesRefilled = 0;
        let extraPaid = 0;

        for (const duty of duties) {
            const relist = duty.autoRelist || {};
            const hasRelistThisMonth = (relist.history || [])
                .some(h => new Date(h.timestamp) >= monthStart);
            if (!hasRelistThisMonth) continue;

            dutiesRelisted += 1;

            const wasRefilled = ['assigned', 'in-progress', 'enroute', 'pending-confirmation', 'completed'].includes(duty.status);
            if (wasRefilled) dutiesRefilled += 1;

            if (wasRefilled && relist.rateBoostApplied && relist.originalOfferedRate != null) {
                extraPaid += (duty.offeredRate - relist.originalOfferedRate);
            }
        }

        return { dutiesRelisted, dutiesRefilled, extraPaid };
    },

    // Get active duties for hospital with filtering and real-time tracking
    async getHospitalActiveDuties(hospitalId, filters = {}) {
        const { role, status, page = 1, limit = 10 } = filters;

        // Build base query for hospital's active duties
        let query = {
            hospital: hospitalId, // Query directly by hospital ID
            status: { $in: ['assigned', 'enroute', 'in-progress'] }
        };


        // Add role filter if specified
        if (role) {
            if (!ALLOWED_ROLES.includes(role)) {
                throw new ValidationError(`Invalid role: ${role}`);
            }
            query.staffRole = role;
        }

        // Add status filter if specified
        if (status) {
            const allowedStatuses = ['assigned', 'enroute', 'in-progress'];
            if (!allowedStatuses.includes(status)) {
                throw new ValidationError(`Invalid status: ${status}`);
            }
            query.status = status;
        }

        // Get total count for pagination
        const totalDuties = await Duty.countDocuments(query);

        // Calculate pagination parameters
        const { skip } = getPaginationParams(page, limit);

        // Fetch duties with populated data
        const duties = await Duty.find(query)
            .populate({
                path: 'assignedTo',
                select: 'fullName user coordinates currentAddress city state pincode',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .populate('hospital', 'hospitalLegalName location coordinates')
            .sort({ createdAt: -1 }) // Latest duties first
            .skip(skip)
            .limit(limit);

        // Batch process real-time locations for better performance
        const staffUserIds = duties
            .filter(duty => duty.assignedTo && duty.assignedTo.user)
            .map(duty => duty.assignedTo.user._id);

        // Get all real-time locations in batch
        const realtimeLocations = await getBatchStaffLocations(staffUserIds);

        const formattedDuties = await Promise.all(
            duties.map(async (duty) => {
                return await formatActiveDuty(duty, realtimeLocations);
            })
        );

        return {
            duties: formattedDuties,
            pagination: {
                totalItems: totalDuties,
                totalPages: Math.ceil(totalDuties / limit),
                currentPage: page,
                itemsPerPage: limit,
                hasNextPage: page < Math.ceil(totalDuties / limit),
                hasPrevPage: page > 1,
                nextPage: page < Math.ceil(totalDuties / limit) ? page + 1 : null,
                prevPage: page > 1 ? page - 1 : null
            },
            filters: {
                role: role || 'all',
                status: status || 'all'
            },
            summary: {
                totalActiveDuties: totalDuties,
                assignedCount: await Duty.countDocuments({ ...query, status: 'assigned' }),
                enrouteCount: await Duty.countDocuments({ ...query, status: 'enroute' }),
                inProgressCount: await Duty.countDocuments({ ...query, status: 'in-progress' })
            }
        };
    },

    // Get duty route map with polyline for hospital (hospital-specific)
    async getHospitalDutyRouteMap(dutyId, hospitalId) {
        // Verify duty belongs to hospital
        const duty = await Duty.findOne({
            _id: dutyId,
            hospital: hospitalId
        })
            .populate({
                path: 'assignedTo',
                select: 'fullName user coordinates phoneNumber skills averageRating totalRatings experience currentAddress city state pincode email verificationStatus education profileSummary',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .populate('hospital', 'hospitalLegalName location currentAddress coordinates');

        if (!duty) {
            throw new NotFoundError('Duty not found or does not belong to your hospital');
        }

        // Verify duty is in active state
        if (!['assigned', 'enroute', 'in-progress'].includes(duty.status)) {
            throw new ValidationError('Duty is not in active state');
        }

        if (!duty.assignedTo) {
            throw new ValidationError('Duty is not assigned to any staff');
        }

        // Use hospital-specific route formatting (not admin service)
        return await this.formatDutyRouteMap(duty);
    },

    // Format duty route map for hospital (hospital-specific view)
    async formatDutyRouteMap(duty) {
        try {
            const staff = duty.assignedTo;
            const hospital = duty.hospital;

            // Get current staff location with fallback
            let currentLocation = null;
            let locationSource = 'unknown';

            // Try real-time location first
            if (staff && staff.user) {
                const redis = await redisClient.getClientAsync();

                try {
                    const key = `staff_location:${staff.user._id}`;
                    const data = await redis.get(key);

                    if (data) {
                        currentLocation = JSON.parse(data);
                        locationSource = 'realtime';
                    }
                } catch (error) {
                    console.error('Error getting real-time location:', error);
                }
            }

            // Fallback to staff's registered coordinates
            if (!currentLocation && staff && staff.coordinates) {
                currentLocation = {
                    latitude: staff.coordinates.coordinates.latitude,
                    longitude: staff.coordinates.coordinates.longitude,
                    timestamp: new Date(),
                    accuracy: null,
                    source: 'registered_address'
                };
                locationSource = 'registered_address';
            }

            if (!currentLocation) {
                throw new ValidationError('Unable to determine staff location');
            }

            // Get route information
            let routeInfo = null;

            try {
                routeInfo = await geocodingService.getDirections(
                    currentLocation.latitude,
                    currentLocation.longitude,
                    hospital.coordinates.coordinates.latitude,
                    hospital.coordinates.coordinates.longitude
                );
            } catch (routeError) {
                console.error('Error getting route directions:', routeError);
                // Fallback: set routeInfo to null when directions API fails
                routeInfo = {
                    overviewPolyline: null,
                    stepPolylines: [],
                    distance: null,
                    duration: null,
                    distanceText: null,
                    durationText: null,
                    steps: [],
                    source: 'error'
                };
            }

            const { ratingShown: staffEffectiveRating } = await ratingAlgorithmService.getEffectiveRating(staff, 'hospital_to_staff');

            // Return hospital-specific route map
            return {
                staff: {
                    name: staff.fullName,
                    email: staff.user?.email || staff.email,
                    mobileNumber: staff.phoneNumber,
                    skills: staff.skills || [],
                    avgRating: staff.averageRating || 0,
                    effectiveRating: staffEffectiveRating,
                    address: staff.currentAddress ? `${staff.currentAddress}, ${staff.city}, ${staff.state} - ${staff.pincode}` : `${staff.city}, ${staff.state} - ${staff.pincode}`,
                    currentAddress: staff.currentAddress,
                    city: staff.city,
                    state: staff.state,
                    pincode: staff.pincode,
                    location: {
                        latitude: currentLocation.latitude,
                        longitude: currentLocation.longitude,
                        lastUpdated: currentLocation.timestamp,
                        accuracy: currentLocation.accuracy || null,
                        source: locationSource
                    },
                    experience: staff.experience,
                    verificationStatus: staff.verificationStatus,
                    education: staff.education || [],
                    profileSummary: staff.profileSummary || null
                },
                duty: {
                    dutyId: duty._id,
                    dutyRole: duty.staffRole,
                    formattedRole: duty.formattedRole,
                    hospitalName: hospital.hospitalLegalName,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    date: duty.date,
                    endDate: duty.endDate,
                    description: duty.description || null,
                    totalPayment: duty.totalPayment || 0,
                    offeredRate: duty.offeredRate || 0,
                    status: duty.status,
                    urgency: duty.urgency,
                    statusHistory: duty.statusHistory || [],
                    assignedAt: duty.assignedAt,
                    enrouteAt: duty.enrouteAt,
                    startedAt: duty.startedAt,
                    completedAt: duty.completedAt
                },
                hospital: {
                    id: hospital._id,
                    name: hospital.hospitalLegalName,
                    currentAddress: hospital.currentAddress,
                    city: hospital.city,
                    state: hospital.state,
                    pincode: hospital.pincode,
                    location: hospital.location,
                    coordinates: {
                        latitude: hospital.coordinates.coordinates.latitude,
                        longitude: hospital.coordinates.coordinates.longitude
                    }
                },
                route: {
                    polyline: routeInfo.overviewPolyline,
                    stepPolylines: routeInfo.stepPolylines || [],
                    distance: routeInfo.distance,
                    distanceText: routeInfo.distanceText,
                    duration: routeInfo.duration,
                    durationText: routeInfo.durationText,
                    steps: routeInfo.steps || [],
                    source: routeInfo.source
                },
                tracking: {
                    isRealTime: duty.status === 'enroute' || duty.status === 'in-progress',
                    updateInterval: 2000, // 2 seconds for real-time tracking
                    lastUpdate: currentLocation.timestamp,
                    estimatedArrival: routeInfo.duration ?
                        new Date(Date.now() + routeInfo.duration * 60 * 1000) : null,
                    accuracy: currentLocation.accuracy || null
                },
                metadata: {
                    generatedAt: new Date(),
                    mapType: 'hospital_route_tracking',
                    source: 'google_maps_api',
                    version: 'v2.0',
                    cacheExpiry: 30 // seconds
                }
            };
        } catch (error) {
            console.error('Error in formatDutyRouteMap:', error);
            throw error;
        }
    },

    /**
     * Get consolidated emergency dashboard list.
     * Includes: urgency emergency/high + any unassigned duty flagged as escalated.
     */
    async getEmergencyDashboard({ page = 1, limit = 20 } = {}) {
        const { skip } = getPaginationParams(page, limit);

        const query = {
            status: { $in: ['available', 'assigned', 'enroute', 'in-progress'] },
            $or: [
                { urgency: { $in: ['emergency', 'high'] } },
                { escalatedToCritical: true },       // auto-escalated unassigned duties
                { unfilledCriticalNotified: true }   // escalated before the separate flag, or past the 30-minute alert
            ]
        };

        const [duties, total] = await Promise.all([
            Duty.find(query)
                .populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } })
                .populate({ path: 'assignedTo', populate: { path: 'user', select: 'name email' } })
                .sort({ urgency: -1, date: 1, startTime: 1 })
                .skip(skip)
                .limit(limit),
            Duty.countDocuments(query)
        ]);

        const istNow = getCurrentIST();

        const formatted = duties.map(duty => {
            const [h, m] = duty.startTime.split(':').map(Number);
            const istDutyDate = toIST(new Date(duty.date));
            const dutyStart = new Date(istDutyDate);
            dutyStart.setHours(h, m, 0, 0);

            const minutesUntilStart = Math.round((dutyStart - istNow) / 60000);
            let etaLabel;
            if (minutesUntilStart <= 0) {
                etaLabel = 'Immediate';
            } else if (minutesUntilStart < 60) {
                etaLabel = `${minutesUntilStart} min`;
            } else {
                const hrs = Math.floor(minutesUntilStart / 60);
                const mins = minutesUntilStart % 60;
                etaLabel = mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
            }

            return {
                id: duty._id,
                isDemo: duty.isDemo === true,
                hospital: {
                    id: duty.hospital?._id,
                    name: duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'N/A',
                    address: duty.hospital?.currentAddress,
                    city: duty.hospital?.city
                },
                staffRole: duty.staffRole,
                date: duty.date,
                startTime: duty.startTime,
                endTime: duty.endTime,
                urgency: duty.urgency,
                status: duty.status,
                assignedTo: duty.assignedTo ? {
                    id: duty.assignedTo._id,
                    name: duty.assignedTo.user?.name
                } : null,
                eta: etaLabel,
                minutesUntilStart,
                offeredRate: duty.offeredRate
            };
        });

        return {
            duties: formatted,
            pagination: getPaginationMeta(total, page, limit)
        };
    }
};
