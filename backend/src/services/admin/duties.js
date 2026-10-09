// Admin: live, overnight and past duties, route map, creating duties for a hospital
// Methods of AdminService; mixed into the class in ../admin.service.js, so `this` is the service.
const mongoose = require('mongoose');
const Duty = require('../../models/Duty');
const MedicalStaff = require('../../models/MedicalStaff');
const Hospital = require('../../models/Hospital');
const User = require('../../models/User');
const { calculateDutyDuration, formatDuration } = require('../../utils/helpers');
const { getPaginationParams, getPaginationMeta } = require('../../utils/pagination');
const { ALLOWED_ROLES } = require('../../utils/constants');
const geocodingService = require('../geocoding.service');
const locationTrackingService = require('../locationTracking.service');
const redisClient = require('../../config/redis');
const { getBatchStaffLocations, formatActiveDuty } = require('../../utils/activeDuty.helper');
const logger = require('../../utils/logger');
const notificationEmitter = require('../notificationEmitter');
const SystemConfigService = require('../systemConfig.service');
const ratingAlgorithmService = require('../ratingAlgorithm.service');
const { ValidationError, NotFoundError } = require('../../middleware/error.middleware');
const { escapeRegex } = require('./helpers');

module.exports = {
    // Get active duties with filtering capabilities
    async getActiveDuties(filters) {
        const { role, location, status, page = 1, limit = 10 } = filters;

        // Build base query for active duties
        const activeStatuses = ['assigned', 'enroute', 'in-progress'];
        let query = {
            status: status ? [status] : activeStatuses
        };

        // Role-based filtering
        if (role) {
            if (!ALLOWED_ROLES.includes(role)) {
                throw new ValidationError(`Invalid role: ${role}`);
            }
            query.staffRole = role;
        }

        // Location-based filtering
        if (location) {
            const locationFilter = await this.buildLocationFilter(location);
            if (locationFilter) {
                query = { ...query, ...locationFilter };
            }
        }

        // Get total count for pagination (before filtering)
        const totalDuties = await Duty.countDocuments(query);

        // Calculate pagination parameters
        const { skip } = getPaginationParams(page, limit);

        // Fetch duties with populated data
        const duties = await Duty.find(query)
            .populate({
                path: 'assignedTo',
                select: 'fullName user coordinates currentAddress city state pincode email',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .populate('hospital', 'hospitalLegalName currentAddress city state pincode coordinates')
            .sort({ createdAt: -1 }) // Latest duties first
            .skip(skip)
            .limit(limit);

        // Filter out duties with missing staff data before processing
        const validDuties = duties.filter(duty => duty.assignedTo);

        // Batch process real-time locations for better performance
        const staffUserIds = validDuties
            .filter(duty => duty.assignedTo && duty.assignedTo.user)
            .map(duty => duty.assignedTo.user._id);

        // Get all real-time locations in batch
        const realtimeLocations = await getBatchStaffLocations(staffUserIds);

        const formattedDuties = await Promise.all(
            validDuties.map(async (duty) => {
                return await formatActiveDuty(duty, realtimeLocations);
            })
        );

        // Filter out null results from duties with missing staff
        const validFormattedDuties = formattedDuties.filter(duty => duty !== null);

        return {
            duties: validFormattedDuties,
            pagination: getPaginationMeta(validFormattedDuties.length, page, limit),
            filters: {
                role: role || 'all',
                location: location || 'all',
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

    // Get duty route map with polyline and real-time tracking
    async getDutyRouteMap(dutyId) {
        try {
            // Redis cache key for optimization
            const cacheKey = `duty_route_map:${dutyId}`;
            const redis = await redisClient.getClientAsync(); // Get the actual Redis client
            const cachedResult = await redis.get(cacheKey);
            
            if (cachedResult) {
                return JSON.parse(cachedResult);
            }

            // Enhanced population with all required fields
            const duty = await Duty.findById(dutyId)
                .populate({
                    path: 'assignedTo',
                    select: 'fullName user coordinates phoneNumber skills averageRating totalRatings experience currentAddress city state pincode email verificationStatus education profileSummary',
                    populate: {
                        path: 'user',
                        select: 'name email'
                    }
                })
                .populate('hospital', 'hospitalLegalName currentAddress city state pincode coordinates')
                .lean(); // Use lean for better performance

            if (!duty) {
                throw new NotFoundError('Duty not found');
            }

            // Verify duty is in active state
            if (!['assigned', 'enroute', 'in-progress'].includes(duty.status)) {
                throw new ValidationError('Duty is not in active state');
            }

            if (!duty.assignedTo) {
                throw new ValidationError('Duty is not assigned to any staff');
            }

            const staff = duty.assignedTo;
            const hospital = duty.hospital;

            // Get current staff location with fallback
            let currentLocation = await locationTrackingService.getStaffLocation(staff.user._id);
            
            // Fallback to staff's registered coordinates if real-time location unavailable
            if (!currentLocation) {
                currentLocation = {
                    latitude: staff.coordinates.coordinates.latitude,
                    longitude: staff.coordinates.coordinates.longitude,
                    timestamp: new Date(),
                    accuracy: null,
                    source: 'registered_address'
                };
            }

            // Enhanced route information with detailed steps
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

            // Enhanced response with all required fields
            const enhancedResponse = {
                staff: {
                    name: staff.fullName,
                    email: staff.user?.email || null,
                    mobileNumber: staff.phoneNumber,
                    skills: staff.skills || [],
                    avgRating: staff.averageRating || 0,
                    effectiveRating: staffEffectiveRating,
                    currentAddress: staff.currentAddress,
                    city: staff.city,
                    state: staff.state,
                    pincode: staff.pincode,
                    location: {
                        latitude: currentLocation.latitude,
                        longitude: currentLocation.longitude,
                        lastUpdated: currentLocation.timestamp,
                        accuracy: currentLocation.accuracy || null,
                        source: currentLocation.source || 'realtime'
                    },
                    experience: staff.experience,
                    verificationStatus: staff.verificationStatus,
                    education: staff.education || [],
                    profileSummary: staff.profileSummary || null
                },
                duty: {
                    dutyId: duty._id,
                    isDemo: duty.isDemo === true,
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
                    address: hospital.currentAddress,
                    city: hospital.city,
                    state: hospital.state,
                    pincode: hospital.pincode,
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
                        new Date(Date.now() + routeInfo.duration * 1000) : null,
                    accuracy: currentLocation.accuracy || null
                },
                metadata: {
                    generatedAt: new Date(),
                    mapType: 'enhanced_route_tracking',
                    source: 'google_maps_api',
                    version: 'v2.0',
                    cacheExpiry: 30 // seconds
                }
            };

            // Cache the result for 30 seconds to optimize for high traffic
            await redis.setex(cacheKey, 30, JSON.stringify(enhancedResponse));

            return enhancedResponse;
        } catch (error) {
            console.error('Error in getDutyRouteMap:', error);
            throw error;
        }
    },

    // GET /api/admin/overnight-duties - Get live overnight duties
    async getOvernightDuties() {
        try {
            const now = new Date();
            
            // Query for overnight duties that are currently active
            const overnightDuties = await Duty.find({
                isOvernightDuty: true,
                status: { $in: ['assigned', 'enroute', 'in-progress'] },
                date: { $lte: now } // Started today or earlier
            })
            .populate({
                path: 'assignedTo',
                select: 'fullName jobRole user',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .populate('hospital', 'hospitalLegalName location')
            .sort({ startTime: 1 })
            .lean();

            // Format the duties with remaining time calculation
            const formattedDuties = overnightDuties.map(duty => {
                const staff = duty.assignedTo;
                const hospital = duty.hospital;
                
                // Calculate remaining time
                const dutyDate = new Date(duty.date);
                const [endHours, endMinutes] = duty.endTime.split(':');
                const dutyEndTime = new Date(dutyDate);
                dutyEndTime.setHours(parseInt(endHours), parseInt(endMinutes), 0, 0);
                
                // If overnight, end time is next day
                if (duty.isOvernightDuty) {
                    dutyEndTime.setDate(dutyEndTime.getDate() + 1);
                }
                
                const remainingMs = dutyEndTime - now;
                const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
                const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
                
                // Determine current load status based on duty status and time
                let currentLoad = 'Optimal';
                if (duty.status === 'in-progress') {
                    if (remainingHours < 2) {
                        currentLoad = 'High';
                    } else if (remainingHours < 4) {
                        currentLoad = 'Moderate';
                    }
                } else if (duty.status === 'assigned') {
                    currentLoad = 'On-Call';
                }
                
                return {
                    id: duty._id,
                    isDemo: duty.isDemo === true,
                    staffName: staff?.fullName || 'Unknown',
                    staffRole: duty.staffRole,
                    formattedRole: duty.formattedRole,
                    hospitalName: hospital?.hospitalLegalName || 'Unknown',
                    hospitalLocation: hospital?.location || 'Unknown',
                    ward: duty.description || 'General Ward',
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    timeRange: `${duty.startTime} - ${duty.endTime}`,
                    remainingTime: remainingHours > 0 
                        ? `${remainingHours}h ${remainingMinutes}m remaining`
                        : `${remainingMinutes}m remaining`,
                    currentLoad,
                    status: duty.status,
                    date: duty.date
                };
            });

            return {
                duties: formattedDuties,
                count: formattedDuties.length
            };
        } catch (error) {
            console.error('Error in getOvernightDuties:', error);
            throw error;
        }
    },

    // GET /api/admin/duty-history - Get completed duty history with filters
    async getDutyHistory({ date, startDate, endDate, hospitalName, page = 1, limit = 10, relisted = false }) {
        try {
            // Build query - start with completed status only
            const query = {
                status: 'completed'
            };

            if (relisted) {
                query['autoRelist.relistCount'] = { $gt: 0 };
            }
            
            // Build date filter
            let dateFilter;
            if (date || startDate || endDate) {
                // Use provided date filters
                dateFilter = this.buildDateFilter(startDate, endDate, date);
            } else {
                // Default: last 7 days (1 week)
                const today = new Date();
                const oneWeekAgo = new Date(today);
                oneWeekAgo.setDate(today.getDate() - 7);
                
                dateFilter = {
                    $gte: new Date(oneWeekAgo.getFullYear(), oneWeekAgo.getMonth(), oneWeekAgo.getDate()),
                    $lt: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
                };
            }
            
            // Use $or to check both completedAt and date fields
            // This handles cases where completedAt might not be set
            query.$or = [
                { completedAt: dateFilter },
                { date: dateFilter }
            ];
            
            // Add hospital name filter if provided
            let hospitalIds = null;
            if (hospitalName) {
                const hospitals = await Hospital.find({
                    hospitalLegalName: { $regex: escapeRegex(hospitalName.trim()), $options: 'i' }
                }).select('_id');
                
                if (hospitals.length === 0) {
                    // No hospitals found with this name
                    return {
                        duties: [],
                        pagination: {
                            currentPage: page,
                            totalPages: 0,
                            totalItems: 0,
                            itemsPerPage: limit,
                            hasNextPage: false,
                            hasPrevPage: false
                        },
                        filters: {
                            date: date || null,
                            startDate: startDate || null,
                            endDate: endDate || null,
                            hospitalName: hospitalName || null,
                            relisted
                        }
                    };
                }
                
                hospitalIds = hospitals.map(h => h._id);
                query.hospital = { $in: hospitalIds };
            }
            
            // Get total count for pagination
            const totalDuties = await Duty.countDocuments(query);
            
            // Calculate pagination
            const { skip } = getPaginationParams(page, limit);
            
            // Fetch duties - sort by completedAt if available, otherwise by date
            const duties = await Duty.find(query)
                .populate({
                    path: 'assignedTo',
                    select: 'fullName jobRole user',
                    populate: {
                        path: 'user',
                        select: 'name email'
                    }
                })
                .populate('hospital', 'hospitalLegalName currentAddress city state pincode')
                .sort({ completedAt: -1, date: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            
            // Format duties
            const formattedDuties = duties.map(duty => {
                const staff = duty.assignedTo;
                const hospital = duty.hospital;
                
                // Calculate hours completed
                const duration = formatDuration(
                    duty.startTime,
                    duty.endTime,
                    duty.date,
                    duty.isOvernightDuty,
                    duty.endDate
                );
                
                return {
                    id: duty._id,
                    isDemo: duty.isDemo === true,
                    staffName: staff?.fullName || 'Unknown',
                    staffEmail: staff?.user?.email || null,
                    staffRole: duty.staffRole,
                    formattedRole: duty.formattedRole,
                    department: duty.description || 'General',
                    hospitalName: hospital?.hospitalLegalName || 'Unknown',
                    hospitalLocation: hospital?.currentAddress ? {
                        currentAddress: hospital.currentAddress,
                        city: hospital.city,
                        state: hospital.state,
                        pincode: hospital.pincode
                    } : null,
                    shiftDuration: duration,
                    hoursCompleted: calculateDutyDuration(
                        duty.date,
                        duty.startTime,
                        duty.endTime,
                        duty.isOvernightDuty,
                        duty.endDate
                    ),
                    date: duty.date,
                    completedAt: duty.completedAt,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    timeRange: `${duty.startTime} - ${duty.endTime}`,
                    status: 'COMPLETED',
                    totalPayment: duty.totalPayment,
                    offeredRate: duty.offeredRate
                };
            });
            
            return {
                duties: formattedDuties,
                pagination: getPaginationMeta(totalDuties, page, limit),
                filters: {
                    date: date || null,
                    startDate: startDate || null,
                    endDate: endDate || null,
                    hospitalName: hospitalName || null,
                    relisted
                }
            };
        } catch (error) {
            console.error('Error in getDutyHistory:', error);
            throw error;
        }
    },

    // Create duty for hospital from admin panel
    // POST /api/admin/duties
    async createDutyForHospital(hospitalId, dutyPayload) {
        const {
            staff_role,
            date,
            end_date,
            start_time,
            end_time,
            urgency,
            description,
            offered_rate,
            is_overnight_duty,
            staff_count,
            duty_sub_type,
            auto_relist_enabled,
            invite_staff_ids,
            open_after_invite
        } = dutyPayload;

        // Doctors invited by name are checked before anything is created
        const invitees = await require('./dutyInvite.service').resolveInvitees(invite_staff_ids, staff_role, { hospitalId });

        // Fetch and validate hospital
        const hospital = await Hospital.findById(hospitalId)
            .select('hospitalLegalName currentAddress city state pincode coordinates servicesAvailable staffCount isProfileComplete verificationStatus user')
            .populate('user', '_id name');

        if (!hospital) {
            const error = new Error('Hospital not found');
            error.statusCode = 404;
            throw error;
        }

        // Check hospital verification status
        if (hospital.verificationStatus !== 'verified') {
            const statusMessages = {
                pending: 'Cannot create duty: hospital verification is still pending.',
                rejected: 'Cannot create duty: hospital has been rejected and is not verified.'
            };
            const message = statusMessages[hospital.verificationStatus] || 'Cannot create duty: hospital is not verified.';
            const error = new Error(message);
            error.statusCode = 403;
            throw error;
        }

        // Determine number of duties to create (default to 1 if staff_count not provided)
        const numberOfDuties = staff_count ? parseInt(staff_count) : 1;

        const dutyData = {
            staffRole: staff_role,
            date,
            endDate: end_date,
            startTime: start_time,
            endTime: end_time,
            urgency,
            description,
            offeredRate: offered_rate,
            isOvernightDuty: is_overnight_duty || false,
            ...(staff_role === 'rmo' && { dutySubType: duty_sub_type }),
            ...(typeof auto_relist_enabled === 'boolean' && { autoRelist: { enabled: auto_relist_enabled } }),
            ...require('../utils/dutyPricing').anesthesiaFields(dutyPayload)
        };

        // Slots of one post share a groupId
        if (numberOfDuties > 1) {
            dutyData.groupId = new mongoose.Types.ObjectId();
        }

        // Create multiple duties based on staff_count
        const createdDuties = [];
        for (let i = 0; i < numberOfDuties; i++) {
            // Use the hospital's own user ID so existing service logic works unchanged
            const DutyService = require('./duty.service');
            const result = await DutyService.createDuty(dutyData, hospital.user._id);
            createdDuties.push(result.duty);
        }
        require('./dutyCalendar.service').invalidateCounts(hospital.user._id.toString());

        // Notify matching staff + hospital (same as hospital flow)
        try {
            // Same staged offer as a hospital post; without it, every
            // available staff member of the role (the old behaviour)
            const offerStart = await require('./dutyOffer.service').startOffer(
                createdDuties,
                hospital,
                invitees.length ? { staff: invitees, openAfterInvite: open_after_invite !== false } : null
            );
            let staffUserIds = offerStart?.userIds;
            if (!staffUserIds) {
                const matchingStaff = await MedicalStaff.find({
                    jobRole: staff_role,
                    isAvailable: true
                }).populate('user', '_id');

                // Filter out staff with null user references and map to user IDs
                staffUserIds = matchingStaff
                    .filter(s => s.user && s.user._id)
                    .map(s => s.user._id.toString());
            }

            const hospitalUserId = hospital.user._id.toString();

            Duty.updateMany(
                { _id: { $in: createdDuties.map(d => d._id) } },
                { $set: { notifiedCount: staffUserIds.length } }
            ).catch(err => logger.error('Error saving notified count:', err));

            // Several slots posted together go out as one notification naming the count
            const batchThreshold = await SystemConfigService.getEffective('calendar.batchNotificationThreshold');
            // Invited doctors get a named invite instead of the general offer
            const offerUserIds = offerStart?.invited ? [] : staffUserIds;
            if (offerStart?.invited) {
                await notificationEmitter.emitDutyInvite(createdDuties[0], staffUserIds, hospital.hospitalLegalName, {
                    count: createdDuties.length,
                    dutyIds: createdDuties.map(d => d._id.toString()),
                    openAfterInvite: createdDuties[0].offer.openAfterInvite,
                    inviteExpiresAt: createdDuties[0].offer.nextActionAt
                });
            }
            if (createdDuties.length >= batchThreshold) {
                await notificationEmitter.emitDutyCreated(createdDuties[0], hospital, offerUserIds, hospitalUserId, {
                    count: createdDuties.length,
                    dutyIds: createdDuties.map(d => d._id.toString())
                });
            } else {
                // Send notifications for all created duties
                for (const duty of createdDuties) {
                    await notificationEmitter.emitDutyCreated(duty, hospital, offerUserIds, hospitalUserId);
                }
            }

            // Notify all admins if this is an emergency duty
            if (urgency === 'emergency') {
                const admins = await User.find({ role: 'admin' }).select('_id');
                if (admins.length) {
                    const adminIds = admins.map(a => a._id.toString());
                    
                    // Send emergency alerts for all created duties
                    for (const duty of createdDuties) {
                        await notificationEmitter.emitEmergencyAdminAlert(duty, hospital, adminIds, 'emergency_created');

                        const alertEmail = process.env.ADMIN_LOGIN_ALERT_EMAIL;
                        if (alertEmail) {
                            require('./email.service').sendEmergencyAdminAlertEmail(
                                alertEmail, 'Admin', duty, hospital, 'emergency_created'
                            ).catch(err => logger.error(`Error sending emergency alert email: ${err.message}`));
                        }
                    }
                }
            }
        } catch (err) {
            logger.error('Admin createDuty: notification error - ' + err.message);
        }

        return {
            success: true,
            duties: createdDuties,
            count: createdDuties.length,
            message: `Successfully created ${createdDuties.length} ${createdDuties.length === 1 ? 'duty' : 'duties'}`
        };
    }
};
