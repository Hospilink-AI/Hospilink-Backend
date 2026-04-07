const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const Review = require('../models/Review');
const {
    doDutiesOverlap,
    toIST,
    getCurrentIST,
    normalizeRole,
    calculateDutyDuration,
    formatDuration
} = require('../utils/helpers');
const geocodingService = require('./geocoding.service');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const User = require('../models/User');
const {
    generateEarningsPDF,
    generateDutyReceiptPDF
} = require('../utils/pdf.puppeteer');

class DutyService {
    async createDuty(dutyData, userId) {
        // Find the hospital profile for this user
        const hospital = await Hospital.findOne({ user: userId });
        if (!hospital) {
            throw new Error('Hospital profile not found. Please complete your profile first.');
        }

        // Additional server-side validation (double-check)
        const now = getCurrentIST();
        const dutyDate = new Date(dutyData.date);
        const [startHours, startMinutes] = dutyData.startTime.split(':');
        
        // Convert duty date to IST and set time
        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);
        
        // Add 15 minute buffer
        const bufferTime = new Date(dutyStartTime.getTime() - 15 * 60 * 1000);
        
        if (bufferTime <= now) {
            throw new Error('Duty start time must be at least 15 minutes in the future. Cannot create duties for past or immediate times.');
        }

        const duty = await Duty.create({
            ...dutyData,
            hospital: hospital._id,
            statusHistory: [{
                status: 'available',
                timestamp: getCurrentIST(),
                changedBy: userId,
                reason: 'Duty created by hospital'
            }]
        });

        // Populate the created duty
        await duty.populate('hospital');

        return {
            success: true,
            duty
        };
    }



    async getDuties(query = {}) {
        let dutyQuery = { ...query };

        // If filtering by hospital user ID, convert to hospital profile ID
        if (query.hospital) {
            const hospital = await Hospital.findOne({ user: query.hospital });
            if (hospital) {
                dutyQuery.hospital = hospital._id;
            } else {
                return [];
            }
        }

        // Exclude expired duties for staff queries
        if (query.staff) {
            dutyQuery.status = {
                $in: ['available', 'assigned', 'enroute', 'in-progress', 'completed', 'cancelled']
            };
        }

        const duties = await Duty.find(dutyQuery)
            .populate('hospital', 'hospitalLegalName currentAddress location')
            .populate({
                path: 'assignedTo',
                populate: {
                    path: 'user',
                    select: 'name email role'
                }
            })
            .populate({
                path: 'assignedTo',
                select: '_id',
                populate: {
                    path: 'user',
                    select: '_id name'
                }
            })
            .sort({ date: 1, startTime: 1 });

        // If staff user, add distance calculations
        if (query.staff) {
            const staff = await MedicalStaff.findOne({ user: query.staff });

            if (staff && staff.coordinates) {
                const staffLat = staff.coordinates.latitude;
                const staffLng = staff.coordinates.longitude;

                // Calculate distance for each duty
                const dutiesWithDistance = [];
                const geocodingService = require('./geocoding.service');

                for (const duty of duties) {
                    if (!duty.hospital.location || !duty.hospital.location.coordinates) {
                        dutiesWithDistance.push({
                            ...duty.toObject(),
                            distance: null,
                            duration: null
                        });
                        continue;
                    }

                    const hospitalLat = duty.hospital.location.coordinates[1];
                    const hospitalLng = duty.hospital.location.coordinates[0];

                    try {
                        const distanceInfo = await geocodingService.calculateDistanceAndETA(
                            staffLat, staffLng, hospitalLat, hospitalLng
                        );

                        dutiesWithDistance.push({
                            ...duty.toObject(),
                            distance: distanceInfo.distance,
                            duration: distanceInfo.duration,
                            distanceText: distanceInfo.distanceText,
                            durationText: distanceInfo.durationText
                        });
                    } catch (error) {
                        console.error('Failed to calculate distance for duty:', error.message);
                        dutiesWithDistance.push({
                            ...duty.toObject(),
                            distance: null,
                            duration: null,
                            distanceText: 'Distance unavailable',
                            durationText: 'ETA unavailable'
                        });
                    }
                }

                // Sort by distance (closest first)
                dutiesWithDistance.sort((a, b) => {
                    if (a.distance === null) return 1;
                    if (b.distance === null) return -1;
                    return a.distance - b.distance;
                });

                return dutiesWithDistance;
            }
        }

        return duties;
    }



    async acceptDuty(dutyId, userId) {
        // Find the medical staff profile for this user
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new Error('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId)
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            });

        if (!duty) {
            throw new Error('Duty not found');
        }

        // Normalize roles for comparison (convert both to lowercase and replace spaces with underscores)
        const normalizedStaffRole = normalizeRole(medicalStaff.jobRole);
        const normalizedDutyRole = normalizeRole(duty.staffRole);

        // Validate staff role matches duty role
        if (normalizedStaffRole !== normalizedDutyRole) {
            throw new Error(`Role mismatch: This duty requires a ${duty.staffRole}, but your profile shows ${medicalStaff.jobRole}`);
        }

        if (duty.status !== 'available') {
            throw new Error('Duty is no longer available');
        }

        // Check if duty has already started
        const now = getCurrentIST();
        const dutyDate = new Date(duty.date);
        const [startHours, startMinutes] = duty.startTime.split(':');

        // Convert duty date to IST first, then set time
        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);

        // Prevent acceptance after start time
        if (now >= dutyStartTime) {
            throw new Error('Cannot accept duty after start time.');
        }

        // Check for overlapping duties
        const existingDuties = await Duty.find({
            assignedTo: medicalStaff._id,
            status: 'assigned',
            $or: [
                { date: duty.date },
                ...(duty.isOvernightDuty && duty.endDate ? [{ date: duty.endDate }] : [])
            ]
        });

        for (const existingDuty of existingDuties) {
            if (doDutiesOverlap(duty, existingDuty)) {
                throw new Error(`Time conflict: You already have a duty from ${existingDuty.startTime} to ${existingDuty.endTime}. New duty from ${duty.startTime} to ${duty.endTime} overlaps.`);
            }
        }

        duty.status = 'assigned';
        duty.assignedTo = medicalStaff._id;
        duty.assignedAt = getCurrentIST();

        // Add status history entry for assignment
        duty.statusHistory.push({
            status: 'assigned',
            timestamp: getCurrentIST(),
            changedBy: medicalStaff.user,
            reason: 'Duty accepted by staff'
        });

        await duty.save();

        // Populate the staff information
        await duty.populate({
            path: 'assignedTo',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        return duty;
    }



    async getUpcomingDutiesForStaff(userId, locationPermission = 'denied', currentLocation = null) {
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
            .populate('hospital', 'hospitalLegalName currentAddress location coordinates')
            .sort({ date: 1, startTime: 1 }); // Sort by date and start time

        // Filter out duties that have already ended today
        const upcomingDuties = duties.filter(duty => {
            const dutyStartDate = new Date(duty.date);
            const dutyEndDate = duty.endDate ? new Date(duty.endDate) : dutyStartDate;

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

        // Add distance calculation if location is available
        let staffLat, staffLng;
        let locationSource = 'profile';

        // Use browser location if permission granted and location provided
        if (locationPermission === 'granted' && currentLocation && currentLocation.latitude && currentLocation.longitude) {
            staffLat = currentLocation.latitude;
            staffLng = currentLocation.longitude;
            locationSource = 'browser';
        } else {
            // Fallback to staff profile location
            if (medicalStaff && medicalStaff.coordinates) {
                if (medicalStaff.coordinates.coordinates) {
                    staffLat = medicalStaff.coordinates.coordinates.latitude;
                    staffLng = medicalStaff.coordinates.coordinates.longitude;
                } else {
                    staffLat = medicalStaff.coordinates.latitude;
                    staffLng = medicalStaff.coordinates.longitude;
                }
            } else {
                // Return duties without distance if no location available
                return upcomingDuties;
            }
        }

        console.log(`Using ${locationSource} location for upcoming duties - staff ${userId}:`, { lat: staffLat, lng: staffLng });

        // Calculate distance for each upcoming duty
        const dutiesWithDistance = [];
        for (const duty of upcomingDuties) {
            if (!duty.hospital.coordinates ||
                !duty.hospital.coordinates.coordinates ||
                !duty.hospital.coordinates.coordinates.latitude ||
                !duty.hospital.coordinates.coordinates.longitude) {
                dutiesWithDistance.push({
                    ...duty.toObject(),
                    distance: null,
                    duration: null
                });
                continue;
            }

            const hospitalLat = duty.hospital.coordinates.coordinates.latitude;
            const hospitalLng = duty.hospital.coordinates.coordinates.longitude;

            try {
                const distanceInfo = await geocodingService.calculateDistanceAndETA(
                    staffLat, staffLng, hospitalLat, hospitalLng
                );

                dutiesWithDistance.push({
                    ...duty.toObject(),
                    distance: distanceInfo.distance,
                    duration: distanceInfo.duration,
                    distanceText: distanceInfo.distanceText,
                    durationText: distanceInfo.durationText
                });
            } catch (error) {
                console.error('Failed to calculate distance for duty:', error.message);
                dutiesWithDistance.push({
                    ...duty.toObject(),
                    distance: null,
                    duration: null,
                    distanceText: 'Distance unavailable',
                    durationText: 'ETA unavailable'
                });
            }
        }

        return dutiesWithDistance;
    }



    async changeDutyStatus(dutyId, userId, newStatus) {
        // Find the medical staff profile for this user
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new Error('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId)
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            });

        if (!duty) {
            throw new Error('Duty not found');
        }

        // Validate staff assignment
        const validation = duty.canChangeStatus(newStatus, medicalStaff._id);
        if (!validation.allowed) {
            throw new Error(validation.reason);
        }

        // Additional timing validations
        if (newStatus === 'enroute') {
            if (duty.status !== 'assigned') {
                throw new Error('Duty must be assigned before marking enroute');
            }
            duty.enrouteAt = getCurrentIST();
        }

        if (newStatus === 'in-progress') {
            const startValidation = duty.canStartDuty();
            if (!startValidation.allowed) {
                throw new Error(startValidation.reason);
            }
            duty.startedAt = getCurrentIST();
        }

        if (newStatus === 'completed') {
            const completeValidation = duty.canCompleteDuty();
            if (!completeValidation.allowed) {
                throw new Error(completeValidation.reason);
            }
            duty.completedAt = getCurrentIST();
        }

        // Update status and add to history
        const previousStatus = duty.status;
        duty.status = newStatus;

        duty.statusHistory.push({
            status: newStatus,
            timestamp: getCurrentIST(),
            changedBy: medicalStaff._id,
            reason: `Status changed from ${previousStatus} to ${newStatus}`
        });

        await duty.save();

        // Populate staff information for response
        await duty.populate({
            path: 'assignedTo',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        return duty;
    }



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
            throw new Error('Duty not found');
        }

        // Authorization check
        if (userRole === 'staff') {
            if (!medicalStaff) {
                throw new Error('Medical staff profile not found');
            }
            if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
                throw new Error('You can only view status history for duties assigned to you');
            }
        } else if (userRole === 'hospital') {
            const hospital = await Hospital.findOne({ user: userId });
            if (!hospital || duty.hospital._id.toString() !== hospital._id.toString()) {
                throw new Error('You can only view status history for your own duties');
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
    }



    async autoCompleteDuties() {
        // Use getCurrentIST() for consistent time handling
        const istNow = getCurrentIST();

        // Get today's date in IST
        const istToday = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());

        const dutiesToComplete = await Duty.find({
            status: 'in-progress',
            date: {
                $gte: new Date(istToday.getFullYear(), istToday.getMonth(), istToday.getDate()),
                $lt: new Date(istToday.getFullYear(), istToday.getMonth(), istToday.getDate() + 1)
            }
        });

        // Prepare bulk operations
        const bulkOps = [];

        for (const duty of dutiesToComplete) {
            // Create proper Date objects for duty end time in IST
            const [endHours, endMinutes] = duty.endTime.split(':').map(Number);
            const dutyEndDate = new Date(duty.date);

            // Convert duty date to IST first, then set the time
            const istDutyDate = toIST(dutyEndDate);
            const istDutyEndTime = new Date(istDutyDate);
            istDutyEndTime.setHours(endHours, endMinutes, 0, 0);

            // Add 15 minutes grace period
            const gracePeriodEndTime = new Date(istDutyEndTime.getTime() + 15 * 60 * 1000);

            // Only complete if current IST time is past the grace period AND status is still 'in-progress'
            if (istNow >= gracePeriodEndTime && duty.status === 'in-progress') {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: duty._id, status: 'in-progress' },
                        update: {
                            $set: {
                                status: 'completed',
                                completedAt: istNow
                            },
                            $push: {
                                statusHistory: {
                                    status: 'completed',
                                    timestamp: istNow,
                                    changedBy: 'system',
                                    reason: 'Automatically completed (not manually completed within 15 minutes after end time)'
                                }
                            }
                        }
                    }
                });
            }
        }

        // Execute bulk operations if any
        let completedCount = 0;
        if (bulkOps.length > 0) {
            const result = await Duty.bulkWrite(bulkOps);
            completedCount = result.modifiedCount;
        }

        return completedCount;
    }



    async expireUnacceptedDuties() {
        const istNow = getCurrentIST();
        const istToday = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());

        // Find available duties from last 7 days (optimized range)
        const dutiesToExpire = await Duty.find({
            status: 'available',
            date: {
                $gte: new Date(istToday.getFullYear(), istToday.getMonth(), istToday.getDate() - 7),
                $lt: new Date(istToday.getFullYear(), istToday.getMonth(), istToday.getDate() + 1)
            }
        }).select('_id date startTime hospital statusHistory'); // Select only needed fields

        const bulkOps = [];

        for (const duty of dutiesToExpire) {
            const [startHours, startMinutes] = duty.startTime.split(':').map(Number);
            const dutyStartDate = new Date(duty.date);
            const istDutyDate = toIST(dutyStartDate);
            const istDutyStartTime = new Date(istDutyDate);
            istDutyStartTime.setHours(startHours, startMinutes, 0, 0);

            // Check if duty started more than 15 minutes ago
            const expireTime = new Date(istDutyStartTime.getTime() + 15 * 60 * 1000);

            if (istNow >= expireTime) {
                bulkOps.push({
                    updateOne: {
                        filter: {
                            _id: duty._id,
                            status: 'available' // Double-check to avoid race conditions
                        },
                        update: {
                            $set: {
                                status: 'expired',
                                expiredAt: istNow
                            },
                            $push: {
                                statusHistory: {
                                    status: 'expired',
                                    timestamp: istNow,
                                    changedBy: 'system',
                                    reason: 'Automatically expired'
                                }
                            }
                        }
                    }
                });
            }
        }

        // Execute bulk operations
        let expiredCount = 0;
        if (bulkOps.length > 0) {
            const result = await Duty.bulkWrite(bulkOps);
            expiredCount = result.modifiedCount;
        }

        return expiredCount;
    }



    async getOngoingDutiesForStaff(userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new Error('Medical staff profile not found');
        }

        const duties = await Duty.find({
            assignedTo: medicalStaff._id,
            status: { $in: ['assigned', 'enroute', 'in-progress'] }
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
    }


    async editDuty(dutyId, userId, updateData) {
        // Find the hospital profile for this user
        const hospital = await Hospital.findOne({ user: userId });
        if (!hospital) {
            throw new Error('Hospital profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new Error('Duty not found');
        }

        // Verify this duty belongs to the requesting hospital
        if (duty.hospital.toString() !== hospital._id.toString()) {
            throw new Error('You can only edit your own duties');
        }

        // Check if duty can be edited (30-minute rule)
        const editValidation = duty.canEditDuty();
        if (!editValidation.allowed) {
            throw new Error(editValidation.reason);
        }

        // Validate and update allowed fields
        const allowedFields = [
            'staffRole', 'date', 'endDate', 'startTime', 'endTime',
            'urgency', 'description', 'offeredRate', 'isOvernightDuty'
        ];

        const updates = {};
        for (const field of allowedFields) {
            if (updateData[field] !== undefined) {
                updates[field] = updateData[field];
            }
        }

        // Apply updates
        Object.assign(duty, updates);
        await duty.save();

        // Populate the updated duty
        await duty.populate({
            path: 'hospital',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        return duty;
    }



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
            throw new Error('Duty not found');
        }

        // Role-based authorization
        console.log(`getDutyDetail called with userRole: "${userRole}" for duty ${dutyId}`);
        if (userRole === 'staff') {
            console.log('Entering staff block - distance calculation will be performed');
            // Find medical staff profile
            const medicalStaff = await MedicalStaff.findOne({ user: userId });
            if (!medicalStaff) {
                throw new Error('Medical staff profile not found');
            }

            // Staff can view available duties OR duties assigned to them
            const isAssigned = duty.assignedTo && duty.assignedTo._id.toString() === medicalStaff._id.toString();
            const isAvailable = duty.status === 'available';

            // Also check that duty is not expired
            const isExpired = duty.status === 'expired';

            if (!isAssigned && !isAvailable) {
                throw new Error('Access denied: You can only view available duties or duties assigned to you');
            }

            if (isExpired) {
                throw new Error('Access denied: This duty has expired and is no longer available');
            }

            // Add distance information for staff members only
            try {
                // Get staff member's current location
                const staff = await MedicalStaff.findOne({ user: userId });
                if (!staff || !staff.coordinates) {
                    throw new Error('Staff location not found. Please update your location.');
                }

                // Handle both old and new coordinate structures
                let staffLat, staffLng;
                if (staff.coordinates.coordinates) {
                    // New structure
                    staffLat = staff.coordinates.coordinates.latitude;
                    staffLng = staff.coordinates.coordinates.longitude;
                } else {
                    // Old structure (backward compatibility)
                    staffLat = staff.coordinates.latitude;
                    staffLng = staff.coordinates.longitude;
                }

                // Check if hospital has coordinates
                if (duty.hospital.coordinates &&
                    duty.hospital.coordinates.coordinates &&
                    duty.hospital.coordinates.coordinates.latitude &&
                    duty.hospital.coordinates.coordinates.longitude) {

                    const hospitalLat = duty.hospital.coordinates.coordinates.latitude;
                    const hospitalLng = duty.hospital.coordinates.coordinates.longitude;

                    console.log(`Processing distance for duty ${duty._id}:`, {
                        staffLocation: { lat: staffLat, lng: staffLng },
                        hospitalLocation: { lat: hospitalLat, lng: hospitalLng },
                        hospitalName: duty.hospital.hospitalLegalName
                    });

                    try {
                        // Calculate distance and ETA using Google Maps API (with Haversine fallback)
                        const distanceInfo = await geocodingService.calculateDistanceAndETA(
                            staffLat, staffLng, hospitalLat, hospitalLng
                        );

                        console.log(`Distance calculation completed for duty ${duty._id}:`, {
                            method: distanceInfo.source,
                            distance: distanceInfo.distanceText,
                            duration: distanceInfo.durationText
                        });

                        // Convert duty to plain object and add distance information
                        const dutyObject = duty.toObject();
                        dutyObject.distance = distanceInfo.distance;
                        dutyObject.duration = distanceInfo.duration;
                        dutyObject.distanceText = distanceInfo.distanceText;
                        dutyObject.durationText = distanceInfo.durationText;
                        dutyObject.hospitalLocation = {
                            latitude: hospitalLat,
                            longitude: hospitalLng,
                            address: duty.hospital.currentAddress
                        };

                        // Add review data before returning
                        const review = await Review.findOne({ duty: dutyId })
                            .select('rating review createdAt');

                        dutyObject.review = review ? {
                            rating: review.rating,
                            review: review.review,
                            reviewedAt: review.createdAt
                        } : null;

                        return dutyObject;
                    } catch (distanceError) {
                        console.error(`Distance calculation failed for duty ${duty._id}:`, distanceError.message);

                        // Add review data even if distance calculation fails
                        const dutyObject = duty.toObject();
                        const review = await Review.findOne({ duty: dutyId })
                            .select('rating review createdAt');

                        dutyObject.review = review ? {
                            rating: review.rating,
                            review: review.review,
                            reviewedAt: review.createdAt
                        } : null;

                        return dutyObject;
                    }
                } else {
                    console.warn(`Hospital coordinates missing for duty ${duty._id}:`, {
                        hospitalId: duty.hospital._id,
                        coordinates: duty.hospital.coordinates
                    });

                    // Still add review data even without coordinates
                    const dutyObject = duty.toObject();
                    const review = await Review.findOne({ duty: dutyId })
                        .select('rating review createdAt');

                    dutyObject.review = review ? {
                        rating: review.rating,
                        review: review.review,
                        reviewedAt: review.createdAt
                    } : null;

                    return dutyObject;
                }
            } catch (error) {
                console.error(`Distance calculation failed for duty ${duty._id}:`, error.message);

                // Add review data even if distance calculation fails
                const dutyObject = duty.toObject();
                const review = await Review.findOne({ duty: dutyId })
                    .select('rating review createdAt');

                dutyObject.review = review ? {
                    rating: review.rating,
                    review: review.review,
                    reviewedAt: review.createdAt
                } : null;

                return dutyObject;
            }
        } else if (userRole === 'hospital') {
            console.log('Entering hospital block - NO distance calculation');
            // Find hospital profile
            const hospital = await Hospital.findOne({ user: userId });
            if (!hospital) {
                throw new Error('Hospital profile not found');
            }

            // Hospital can only view their own duties
            if (duty.hospital._id.toString() !== hospital._id.toString()) {
                throw new Error('Access denied: You can only view your hospital duties');
            }
        } else {
            console.log(`Unknown user role: "${userRole}"`);
        }

        // For hospital users, add review data and return
        const dutyObject = duty.toObject();

        // Add review data for hospital users
        const review = await Review.findOne({ duty: dutyId })
            .select('rating review createdAt');

        dutyObject.review = review ? {
            rating: review.rating,
            review: review.review,
            reviewedAt: review.createdAt
        } : null;

        return dutyObject;
    }




    // Get available jobs with distance calculation for staff member
    async getAvailableJobsWithDistance(staffId, filters = {}, locationPermission = 'denied', currentLocation = null) {
        try {
            // Always get staff information for role and fallback location
            const staff = await MedicalStaff.findOne({ user: staffId });
            if (!staff) {
                throw new Error('Staff profile not found');
            }

            let staffLat, staffLng;
            let locationSource = 'profile';

            // Use browser location if permission granted and location provided
            if (locationPermission === 'granted' && currentLocation && currentLocation.latitude && currentLocation.longitude) {
                staffLat = currentLocation.latitude;
                staffLng = currentLocation.longitude;
                locationSource = 'browser';
            } else {
                // Fallback to staff profile location
                if (!staff.coordinates) {
                    throw new Error('Staff location not found. Please update your location.');
                }

                // Handle both old and new coordinate structures
                if (staff.coordinates.coordinates) {
                    // New structure
                    staffLat = staff.coordinates.coordinates.latitude;
                    staffLng = staff.coordinates.coordinates.longitude;
                } else {
                    // Old structure (backward compatibility)
                    staffLat = staff.coordinates.latitude;
                    staffLng = staff.coordinates.longitude;
                }
            }

            console.log(`Using ${locationSource} location for staff ${staffId}:`, { lat: staffLat, lng: staffLng });

            console.log(`Processing available duties for staff ${staffId}:`, {
                staffLocation: { lat: staffLat, lng: staffLng },
                staffRole: staff.jobRole
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
                .populate('hospital', 'hospitalLegalName currentAddress location coordinates')
                .sort({ date: 1, startTime: 1 });

            // Additional safety filter to ensure no expired duties
            const filteredDuties = duties.filter(duty => duty.status === 'available');

            console.log(`Found ${filteredDuties.length} available duties for staff ${staffId} (filtered from ${duties.length} total)`);


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

                console.log(`Calculating distance for duty ${duty._id}:`, {
                    hospitalName: duty.hospital.hospitalLegalName,
                    staffLocation: { lat: staffLat, lng: staffLng },
                    hospitalLocation: { lat: hospitalLat, lng: hospitalLng }
                });

                try {
                    // Calculate distance and ETA using Google Maps API (with Haversine fallback)
                    const distanceInfo = await geocodingService.calculateDistanceAndETA(
                        staffLat, staffLng, hospitalLat, hospitalLng
                    );

                    console.log(`Distance calculation completed for duty ${duty._id}:`, {
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
                        hospitalLocation: {
                            latitude: hospitalLat,
                            longitude: hospitalLng,
                            address: duty.hospital.currentAddress
                        }
                    };

                    jobsWithDistance.push(jobWithDistance);
                } catch (error) {
                    console.error(`Distance calculation failed for duty ${duty._id}:`, error.message);

                    continue;
                }
            }

            // Sort by distance (closest first)
            jobsWithDistance.sort((a, b) => a.distance - b.distance);

            console.log(`Processed ${jobsWithDistance.length} duties with distance information`);

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
            throw new Error(error.message);
        }
    }



    async getJobRouteInfo(dutyId, staffId, currentLocation) {
        try {
            // Get duty details
            const duty = await Duty.findById(dutyId).populate('hospital', 'hospitalLegalName currentAddress location coordinates');


            if (!duty) {
                throw new Error('Duty not found');
            }

            // Use current location from browser
            const staffLat = currentLocation.latitude;
            const staffLng = currentLocation.longitude;

            // Check for named coordinates structure
            if (!duty.hospital.coordinates ||
                !duty.hospital.coordinates.coordinates ||
                !duty.hospital.coordinates.coordinates.latitude ||
                !duty.hospital.coordinates.coordinates.longitude) {

                throw new Error('Hospital location not found');
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
                        id: duty.hospital._id,  // Add this line
                        name: duty.hospital.hospitalLegalName,
                        address: duty.hospital.currentAddress,
                        location: {
                            latitude: hospitalLat,
                            longitude: hospitalLng
                        }
                    },
                    staffLocation: {
                        latitude: staffLat,
                        longitude: staffLng

                    },
                    // route: {
                    //     polyline: routeInfo.polyline,
                    //     distance: routeInfo.distance,
                    //     duration: routeInfo.duration,
                    //     distanceText: routeInfo.distanceText,
                    //     durationText: routeInfo.durationText,
                    //     steps: routeInfo.steps
                    // }

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
                throw new Error(`Unable to get route information: ${error.message}`);
            }
        } catch (error) {
            throw new Error(error.message);
        }
    }



    async getCompletedDutiesForStaff(staffUserId, page = 1, limit = 10) {
        try {
            // Find the medical staff profile for this user
            const staff = await MedicalStaff.findOne({ user: staffUserId });
            if (!staff) {
                throw new Error('Medical staff profile not found');
            }

            // Import pagination utilities
            const paginationParams = getPaginationParams(page, limit);

            // Get total count for pagination metadata
            const totalDuties = await Duty.countDocuments({
                assignedTo: staff._id,
                status: 'completed'
            });

            // Find completed duties with pagination
            const duties = await Duty.find({
                assignedTo: staff._id,
                status: 'completed'
            })
                .populate('hospital', 'hospitalLegalName currentAddress location')
                .populate({
                    path: 'assignedTo',
                    populate: {
                        path: 'user',
                        select: 'name email role'
                    }
                })
                .sort({ completedAt: -1 }) // Most recent first
                .skip(paginationParams.skip)
                .limit(paginationParams.limit);

            // Fetch reviews for these duties in single query (optimized)
            const dutyIds = duties.map(duty => duty._id);
            const reviews = await Review.find({
                duty: { $in: dutyIds }
            }).select('duty rating review createdAt');

            // Create lookup map for O(1) access
            const reviewMap = {};
            reviews.forEach(review => {
                reviewMap[review.duty.toString()] = review;
            });

            // Calculate summary statistics
            let totalHours = 0;
            let totalEarnings = 0;
            let lastDutyDate = null;

            const dutiesWithDetails = duties.map(duty => {
                // Calculate duration for this duty
                const duration = calculateDutyDuration(
                    duty.date,
                    duty.startTime,
                    duty.endTime,
                    duty.isOvernightDuty,
                    duty.endDate
                );

                totalHours += duration;
                totalEarnings += duty.totalPayment || 0;

                // Track the most recent duty date
                if (!lastDutyDate || duty.completedAt > lastDutyDate) {
                    lastDutyDate = duty.completedAt;
                }

                return {
                    _id: duty._id,
                    hospital: duty.hospital,
                    assignedTo: duty.assignedTo,
                    staffRole: duty.staffRole,
                    status: duty.status,
                    date: duty.date,
                    endDate: duty.endDate,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    isOvernightDuty: duty.isOvernightDuty,
                    urgency: duty.urgency,
                    description: duty.description,
                    offeredRate: duty.offeredRate,
                    totalPayment: duty.totalPayment,
                    duration: formatDuration(
                        duty.startTime,
                        duty.endTime,
                        duty.date,
                        duty.isOvernightDuty,
                        duty.endDate
                    ),
                    assignedAt: duty.assignedAt,
                    completedAt: duty.completedAt,
                    statusHistory: duty.statusHistory,
                    rating: reviewMap[duty._id.toString()] ? {
                        rating: reviewMap[duty._id.toString()].rating,
                        review: reviewMap[duty._id.toString()].review,
                        reviewedAt: reviewMap[duty._id.toString()].createdAt
                    } : null
                };
            });

            return {
                summary: {
                    totalDutiesCompleted: totalDuties,
                    totalHours: formatDuration(totalHours),
                    totalEarnings: Math.round(totalEarnings * 100) / 100,
                    lastDutyDate: lastDutyDate
                },
                duties: dutiesWithDetails,
                pagination: getPaginationMeta(totalDuties, page, limit)
            };

        } catch (error) {
            throw new Error(`Error fetching completed duties: ${error.message}`);
        }
    }

    //Generate Statement
    async generateStatement(userId, filters, res) {
        const { dutyId, startDate, endDate } = filters;

        const completed = await this.getCompletedDutiesForStaff(userId);
        const duties = completed.duties;

        // ========= RECEIPT =========
        if (dutyId) {
            const duty = duties.find(d => d._id.toString() === dutyId);
            if (!duty) throw new Error('Duty not found');

            const receiptData = {
                staff: {
                    name: duty.assignedTo?.user?.name || 'N/A',
                    email: duty.assignedTo?.user?.email || 'N/A',
                    role: duty.assignedTo?.user?.role || duty.staffRole || 'N/A'
                },
                dutyId: duty._id,
                hospital: duty.hospital?.hospitalLegalName || 'N/A',
                summary: {
                    role: duty.staffRole || 'N/A',
                    urgency: duty.urgency || 'Normal',
                    date: duty.completedAt || duty.date,
                    payment: duty.totalPayment || 0
                },
                totalEarning: duty.totalPayment || 0,
                time: {
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    duration: `${duty.duration}`
                }
            };

            return generateDutyReceiptPDF(res, receiptData);
        }

        // ========= EARNINGS =========

        let filtered = duties;

        if (startDate && endDate) {
            filtered = duties.filter(d => {
                const date = new Date(d.completedAt);
                return date >= new Date(startDate) && date <= new Date(endDate);
            });
        }

        let totalEarnings = 0;

        const data = filtered.map(d => {
            totalEarnings += d.totalPayment || 0;

            return {
                dutyDate: d.completedAt,
                hospital: d.hospital?.hospitalLegalName,
                role: d.staffRole,
                amount: d.totalPayment,
                hours: formatDuration(
                    d.startTime,
                    d.endTime,
                    d.date,
                    d.isOvernightDuty,
                    d.endDate
                )
            };
        });

        const user = await User.findById(userId).select('name email role');

        const totalHoursFormatted = completed.summary.totalHours;

        const pdfData = {
            user,
            period: startDate && endDate
                ? `${startDate} to ${endDate}`
                : 'All Time',
            totalEarnings,
            totalDuties: data.length,
            totalHours: totalHoursFormatted,
            data
        };

        return generateEarningsPDF(res, pdfData);
    }
}

module.exports = new DutyService();