const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const Review = require('../models/Review');
const mongoose = require('mongoose');
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
const { ALLOWED_ROLES } = require('../utils/constants');
const User = require('../models/User');
const {
    generateEarningsPDF,
    generateDutyReceiptPDF
} = require('../utils/pdf.puppeteer');
const DashboardService = require('./dashboard.service');
const redisClient = require('../config/redis');
const { getBatchStaffLocations, formatActiveDuty } = require('../utils/activeDuty.helper');
const notificationEmitter = require('./notificationEmitter');
const s3Service = require('./s3.service');
const OTPService = require('./otp.service');
const SMSService = require('./sms.service');
const { isWithinGeofence, GEOFENCE_RADIUS_KM } = require('./geofence.service');
const {
    AppError,
    ValidationError,
    NotFoundError,
    ConflictError,
    ForbiddenError,
    UnprocessableEntityError
} = require('../middleware/error.middleware');

// Per-duty Redis lock TTL in seconds — prevents thundering herd
const DUTY_ACCEPT_LOCK_TTL = 10;

/**
 * Acquire a short-lived Redis lock for a specific duty acceptance attempt.
 * Returns true if lock acquired, false if another request already holds it.
 * Uses SET NX EX (atomic in Redis) — no race condition possible.
 */
async function acquireDutyLock(dutyId, staffId) {
    try {
        const redis = await redisClient.getClientAsync();
        const key = `duty_accept_lock:${dutyId}:${staffId}`;
        // NX = only set if not exists, EX = expire after TTL
        const result = await redis.set(key, '1', 'EX', DUTY_ACCEPT_LOCK_TTL, 'NX');
        return result === 'OK';
    } catch {
        // Redis unavailable — fail open (allow the request through)
        return true;
    }
}

async function releaseDutyLock(dutyId, staffId) {
    try {
        const redis = await redisClient.getClientAsync();
        await redis.del(`duty_accept_lock:${dutyId}:${staffId}`);
    } catch {
        // Best-effort — TTL will clean it up anyway
    }
}

class DutyService {
    async createDuty(dutyData, userId) {
        // Find the hospital profile for this user
        const hospital = await Hospital.findOne({ user: userId });
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
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
            throw new ValidationError('Duty start time must be at least 15 minutes in the future. Cannot create duties for past or immediate times.');
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
                    totalRatings: staff.totalRatings ?? 0
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
    }




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
    }



    async acceptDuty(dutyId, userId) {
        // ── Per-staff idempotency lock ────────────────────────────────────────
        // Prevents the same staff member from firing duplicate requests
        // (e.g. double-tap, network retry) within the lock window.
        const staffLockAcquired = await acquireDutyLock(dutyId, userId.toString());
        if (!staffLockAcquired) {
            throw new ConflictError('Your acceptance request is already being processed. Please wait.');
        }

        // Use a MongoDB session for the overlap check + atomic claim so both
        // operations are isolated from concurrent writes to the same staff member.
        const session = await mongoose.startSession();

        try {
            let claimedDuty;

            await session.withTransaction(async () => {

                // ── 1. Load staff profile ─────────────────────────────────────
                const medicalStaff = await MedicalStaff.findOne({ user: userId }).session(session);
                if (!medicalStaff) {
                    throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
                }

                // ── 2. Load duty for validation ───────────────────────────────
                const duty = await Duty.findById(dutyId)
                    .populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } })
                    .session(session);

                if (!duty) {
                    throw new NotFoundError('Duty not found');
                }

                // ── 3. Role check ─────────────────────────────────────────────
                const normalizedStaffRole = normalizeRole(medicalStaff.jobRole);
                const normalizedDutyRole = normalizeRole(duty.staffRole);

                if (normalizedStaffRole !== normalizedDutyRole) {
                    throw new ForbiddenError(`Role mismatch: This duty requires a ${duty.staffRole}, but your profile shows ${medicalStaff.jobRole}`);
                }

                // ── 4. Status check ───────────────────────────────────────────
                if (duty.status !== 'available') {
                    throw new ConflictError('Duty is no longer available');
                }

                // ── 5. Start time check ───────────────────────────────────────
                const now = getCurrentIST();
                const istDutyDate = toIST(new Date(duty.date));
                const [startHours, startMinutes] = duty.startTime.split(':');
                const dutyStartTime = new Date(istDutyDate);
                dutyStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);

                if (now >= dutyStartTime) {
                    throw new UnprocessableEntityError('Cannot accept duty after start time.');
                }

                // ── 6. Overlap check (inside transaction = consistent read) ───
                // Reading within the same session ensures we see any duties
                // committed by concurrent transactions before this one started.
                const existingDuties = await Duty.find({
                    assignedTo: medicalStaff._id,
                    status: 'assigned',
                    $or: [
                        { date: duty.date },
                        ...(duty.isOvernightDuty && duty.endDate ? [{ date: duty.endDate }] : [])
                    ]
                }).session(session);

                for (const existingDuty of existingDuties) {
                    if (doDutiesOverlap(duty, existingDuty)) {
                        throw new ConflictError(
                            `Time conflict: You already have a duty from ${existingDuty.startTime} to ${existingDuty.endTime}. ` +
                            `New duty from ${duty.startTime} to ${duty.endTime} overlaps.`
                        );
                    }
                }

                // ── 7. Atomic claim ───────────────────────────────────────────
                // findOneAndUpdate with status:'available' as the guard.
                // Inside a transaction this is both atomic AND isolated —
                // concurrent transactions trying the same duty will block
                // until this one commits, then find status='assigned' and abort.
                const assignedAt = getCurrentIST();
                claimedDuty = await Duty.findOneAndUpdate(
                    { _id: dutyId, status: 'available' },
                    {
                        $set: {
                            status: 'assigned',
                            assignedTo: medicalStaff._id,
                            assignedAt
                        },
                        $push: {
                            statusHistory: {
                                status: 'assigned',
                                timestamp: assignedAt,
                                changedBy: medicalStaff.user,
                                reason: 'Duty accepted by staff'
                            }
                        }
                    },
                    { new: true, runValidators: true, session }
                ).populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } });

                if (!claimedDuty) {
                    throw new ConflictError('Duty is no longer available');
                }

            }); // transaction auto-commits or auto-aborts

            // Populate assignedTo outside transaction (read-only, no isolation needed)
            await claimedDuty.populate({
                path: 'assignedTo',
                populate: { path: 'user', select: 'name email' }
            });

            return claimedDuty;

        } finally {
            session.endSession();
            // Always release the per-staff lock regardless of outcome
            await releaseDutyLock(dutyId, userId.toString());
        }
    }



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

        console.log(`[UpcomingDuties] Using ${locationSource} location for staff ${userId}: lat=${staffLat}, lng=${staffLng}`);

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

        console.log(`[UpcomingDuties] Duties with coordinates: ${dutiesWithCoords.length} | Without coordinates: ${dutiesWithoutCoords.length}`);

        // --- Step 2: Build destinations array for batch call ---
        const destinations = dutiesWithCoords.map(duty => ({
            id: duty._id.toString(),
            latitude: duty.hospital.coordinates.coordinates.latitude,
            longitude: duty.hospital.coordinates.coordinates.longitude
        }));

        const batchSize = 25;
        const expectedApiCalls = Math.ceil(destinations.length / batchSize);
        console.log(`[UpcomingDuties] Google Maps batch call — destinations: ${destinations.length} | batch size: ${batchSize} | expected API calls: ${expectedApiCalls}`);

        // --- Step 3: Single batch call instead of N individual calls ---
        let resultMap = new Map();
        let totalApiCalls = 0;

        try {
            ({ resultMap, totalApiCalls } = await geocodingService.calculateBatchDistanceAndETA(
                staffLat, staffLng, destinations
            ));
            console.log(`[UpcomingDuties] Google Maps API calls made: ${totalApiCalls} | successful results: ${resultMap.size}/${destinations.length}`);
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

        console.log(`[UpcomingDuties] ✓ Summary:`);
        console.log(`  DB fetched           : ${duties.length}`);
        console.log(`  After time filter    : ${upcomingDuties.length}`);
        console.log(`  With coordinates     : ${dutiesWithCoords.length}`);
        console.log(`  Without coordinates  : ${dutiesWithoutCoords.length}`);
        console.log(`  Google Maps calls    : ${totalApiCalls}`);

        return dutiesWithDistance;
    }



    async changeDutyStatus(dutyId, userId, newStatus) {
        // Find the medical staff profile for this user
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
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
            throw new NotFoundError('Duty not found');
        }

        // Validate staff assignment
        const validation = duty.canChangeStatus(newStatus, medicalStaff._id);
        if (!validation.allowed) {
            if (validation.reason.includes('assigned to you')) {
                throw new ForbiddenError(validation.reason);
            }
            throw new ValidationError(validation.reason);
        }

        // Additional timing validations
        if (newStatus === 'enroute') {
            if (duty.status !== 'assigned') {
                throw new ValidationError('Duty must be assigned before marking enroute');
            }
            duty.enrouteAt = getCurrentIST();
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
        }).populate('hospital', 'hospitalLegalName currentAddress location user')
            .populate('assignedTo');

        // Prepare bulk operations
        const bulkOps = [];
        const dutiesForNotification = []; // Track duties that will move to pending-confirmation

        // Grace period after scheduled end time before a non-verified duty moves to pending-confirmation
        const graceMinutes = parseInt(process.env.PENDING_CONFIRMATION_GRACE_MINUTES) || 30;

        for (const duty of dutiesToComplete) {
            // Create proper Date objects for duty end time in IST
            const [endHours, endMinutes] = duty.endTime.split(':').map(Number);
            const dutyEndDate = new Date(duty.date);

            // Convert duty date to IST first, then set the time
            const istDutyDate = toIST(dutyEndDate);
            const istDutyEndTime = new Date(istDutyDate);
            istDutyEndTime.setHours(endHours, endMinutes, 0, 0);

            const gracePeriodEndTime = new Date(istDutyEndTime.getTime() + graceMinutes * 60 * 1000);

            // Only move to pending-confirmation if past the grace period, still 'in-progress',
            // and the hospital hasn't already verified the end OTP
            if (istNow >= gracePeriodEndTime && duty.status === 'in-progress' && duty.endOtp.status !== 'VERIFIED') {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: duty._id, status: 'in-progress' },
                        update: {
                            $set: {
                                status: 'pending-confirmation',
                                pendingConfirmationAt: istNow
                            },
                            $push: {
                                statusHistory: {
                                    status: 'pending-confirmation',
                                    timestamp: istNow,
                                    changedBy: 'system',
                                    reason: `Moved to pending-confirmation — hospital did not verify end OTP within ${graceMinutes} minutes of scheduled end time`
                                }
                            }
                        }
                    }
                });

                // Store duty info for notification
                dutiesForNotification.push(duty);
            }
        }

        // Execute bulk operations if any
        let movedCount = 0;
        if (bulkOps.length > 0) {
            const result = await Duty.bulkWrite(bulkOps);
            movedCount = result.modifiedCount;

            // Send notifications for duties moved to pending-confirmation
            if (movedCount > 0 && dutiesForNotification.length > 0) {
                for (const duty of dutiesForNotification) {
                    try {
                        // Get staff details
                        const staff = await MedicalStaff.findById(duty.assignedTo._id || duty.assignedTo)
                            .populate('user', 'name');

                        if (staff && staff.user && duty.hospital && duty.hospital.user) {
                            const hospitalUserId = duty.hospital.user._id?.toString() || duty.hospital.user.toString();
                            const staffUserId = staff.user._id?.toString() || staff.user.toString();

                            // Notify hospital (please confirm) and staff (free to accept new duties)
                            await notificationEmitter.emitDutyPendingConfirmation(duty, staff, hospitalUserId, staffUserId);
                            console.log(`Pending-confirmation notification sent for duty ${duty._id}`);
                        }
                    } catch (notifError) {
                        console.error(`Error sending pending-confirmation notification for duty ${duty._id}:`, notifError);
                        // Continue with other notifications even if one fails
                    }
                }
            }
        }

        return movedCount;
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



    async markIncompleteDuties() {
        const istNow = getCurrentIST();
        const istToday = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());

        // Find duties that are stuck in 'assigned' or 'enroute' status
        // Only check today and yesterday (for overnight duties)
        const stuckDuties = await Duty.find({
            status: { $in: ['assigned', 'enroute'] },
            date: {
                $gte: new Date(istToday.getFullYear(), istToday.getMonth(), istToday.getDate() - 1),
                $lt: new Date(istToday.getFullYear(), istToday.getMonth(), istToday.getDate() + 1)
            }
        }).populate('hospital', 'hospitalLegalName')
            .populate({
                path: 'assignedTo',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            });

        const bulkOps = [];
        const incompleteDuties = [];

        for (const duty of stuckDuties) {
            // Calculate duty start time in IST
            const [startHours, startMinutes] = duty.startTime.split(':').map(Number);
            const dutyStartDate = new Date(duty.date);
            const istDutyDate = toIST(dutyStartDate);
            const istDutyStartTime = new Date(istDutyDate);
            istDutyStartTime.setHours(startHours, startMinutes, 0, 0);

            // Check if 30 minutes have passed since duty start time
            const thirtyMinutesAfterStart = new Date(istDutyStartTime.getTime() + 30 * 60 * 1000);

            if (istNow >= thirtyMinutesAfterStart) {
                const timeDiff = istNow - istDutyStartTime;
                const minutesOverdue = Math.floor(timeDiff / (1000 * 60));

                const staffName = duty.assignedTo?.user?.name || 'Unknown Staff';
                const hospitalName = duty.hospital?.hospitalLegalName || 'Unknown Hospital';

                console.log(`Marking duty INCOMPLETE: ${hospitalName} - ${duty.staffRole} - ${staffName} (${minutesOverdue}min overdue)`);

                incompleteDuties.push({
                    dutyId: duty._id,
                    hospitalName,
                    staffName,
                    staffRole: duty.staffRole,
                    startTime: duty.startTime,
                    previousStatus: duty.status,
                    minutesOverdue
                });

                bulkOps.push({
                    updateOne: {
                        filter: { _id: duty._id },
                        update: {
                            $set: {
                                status: 'incomplete',
                                incompleteAt: istNow
                            },
                            $push: {
                                statusHistory: {
                                    status: 'incomplete',
                                    timestamp: istNow,
                                    changedBy: 'system',
                                    reason: `Automatically marked incomplete - status was '${duty.status}' for ${minutesOverdue} minutes after duty start time`
                                }
                            }
                        }
                    }
                });
            }
        }

        // Execute bulk operations if any
        let markedIncompleteCount = 0;
        if (bulkOps.length > 0) {
            const result = await Duty.bulkWrite(bulkOps);
            markedIncompleteCount = result.modifiedCount;

            console.log(`\n=== INCOMPLETE DUTIES SUMMARY ===`);
            console.log(`Total duties marked incomplete: ${markedIncompleteCount}`);
            incompleteDuties.forEach(duty => {
                console.log(`• ${duty.staffName} - ${duty.staffRole} at ${duty.hospitalName} (${duty.minutesOverdue}min overdue)`);
            });
            console.log(`================================\n`);
        }

        return markedIncompleteCount;
    }


    async sendNavigationReminders() {
        const istNow = getCurrentIST();

        // Find duties that are in 'assigned' status and starting in approximately 30 minutes
        // We check duties starting between 29-31 minutes from now to account for cron timing
        const duties = await Duty.find({
            status: 'assigned' // Only remind if they haven't started their journey yet
        }).populate('hospital', 'hospitalLegalName user')
            .populate({
                path: 'assignedTo',
                populate: {
                    path: 'user',
                    select: 'name email _id'
                }
            });

        const remindersToSend = [];

        for (const duty of duties) {
            try {
                // Calculate duty start time in IST
                const [startHours, startMinutes] = duty.startTime.split(':').map(Number);
                const dutyStartDate = new Date(duty.date);
                const istDutyDate = toIST(dutyStartDate);
                const istDutyStartTime = new Date(istDutyDate);
                istDutyStartTime.setHours(startHours, startMinutes, 0, 0);

                // Calculate time difference in minutes
                const timeDiff = istDutyStartTime - istNow;
                const minutesUntilStart = Math.floor(timeDiff / (1000 * 60));

                // Send reminder if duty starts in 29-31 minutes (to account for cron timing)
                if (minutesUntilStart >= 29 && minutesUntilStart <= 31) {
                    if (duty.assignedTo && duty.assignedTo.user) {
                        remindersToSend.push({
                            duty,
                            staff: duty.assignedTo,
                            staffUserId: duty.assignedTo.user._id.toString(),
                            minutesUntilStart
                        });
                    }
                }
            } catch (error) {
                console.error(`Error processing duty ${duty._id} for navigation reminder:`, error);
            }
        }

        // Send notifications
        if (remindersToSend.length > 0) {
            for (const reminder of remindersToSend) {
                try {
                    await notificationEmitter.emitNavigateToDuty(
                        reminder.duty,
                        reminder.staff,
                        reminder.staffUserId
                    );

                    const hospitalName = reminder.duty.hospital?.hospitalLegalName || 'Hospital';
                    const staffName = reminder.staff.user?.name || 'Staff';
                    console.log(`Navigation reminder sent: ${staffName} for duty at ${hospitalName} (starts in ${reminder.minutesUntilStart} min)`);
                } catch (notifError) {
                    console.error(`Error sending navigation reminder for duty ${reminder.duty._id}:`, notifError);
                }
            }
        }

        return remindersToSend.length;
    }



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
    }


    async editDuty(dutyId, userId, updateData) {
        // Find the hospital profile for this user
        const hospital = await Hospital.findOne({ user: userId });
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        // Verify this duty belongs to the requesting hospital
        if (duty.hospital.toString() !== hospital._id.toString()) {
            throw new ForbiddenError('You can only edit your own duties');
        }

        const isEmergencyOrCritical = duty.urgency === 'emergency';
        const isPricingOnlyUpdate = updateData.offeredRate !== undefined &&
            Object.keys(updateData).every(k => k === 'offeredRate');

        // For emergency duties: allow pricing-only edit until 1 min before start
        if (isEmergencyOrCritical && isPricingOnlyUpdate) {
            const pricingValidation = duty.canEditPricing();
            if (!pricingValidation.allowed) {
                throw new ValidationError(pricingValidation.reason);
            }
            duty.offeredRate = updateData.offeredRate;
            await duty.save();
            await duty.populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } });
            return duty;
        }

        // Standard edit: check 30-minute rule
        const editValidation = duty.canEditDuty();
        if (!editValidation.allowed) {
            // For emergency duties that are still available, suggest pricing-only edit
            if (isEmergencyOrCritical && duty.status === 'available') {
                throw new ValidationError('Emergency duties can only have their pricing edited within 30 minutes of start time. Use offeredRate only.');
            }
            throw new ValidationError(editValidation.reason);
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

        // Validate the new start time is at least 15 minutes in the future.
        // Use the incoming date if provided, otherwise fall back to the existing duty's date.
        if (updates.startTime) {
            const now = getCurrentIST();
            const refDate = new Date(updates.date || duty.date);
            const [startHours, startMinutes] = updates.startTime.split(':');
            const istRefDate = toIST(refDate);
            const newStartTime = new Date(istRefDate);
            newStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);
            const bufferTime = new Date(newStartTime.getTime() - 15 * 60 * 1000);
            if (bufferTime <= now) {
                throw new ValidationError('New start time must be at least 15 minutes in the future');
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
            throw new NotFoundError('Duty not found');
        }

        // Role-based authorization
        console.log(`getDutyDetail called with userRole: "${userRole}" for duty ${dutyId}`);
        if (userRole === 'staff') {
            console.log('Entering staff block - distance calculation will be performed');
            // Find medical staff profile
            const medicalStaff = await MedicalStaff.findOne({ user: userId });
            if (!medicalStaff) {
                throw new NotFoundError('Medical staff profile not found');
            }

            // Staff can view available duties OR duties assigned to them
            const isAssigned = duty.assignedTo && duty.assignedTo._id.toString() === medicalStaff._id.toString();
            const isAvailable = duty.status === 'available';

            // Also check that duty is not expired
            const isExpired = duty.status === 'expired';

            if (!isAssigned && !isAvailable) {
                throw new ForbiddenError('Access denied: You can only view available duties or duties assigned to you');
            }

            if (isExpired) {
                throw new ForbiddenError('Access denied: This duty has expired and is no longer available');
            }

            // Add distance information for staff members only (always show distance)
            try {
                // Get staff real-time location with fallback to profile
                const locationInfo = await DashboardService.getStaffLocationForDuties(userId);
                const staffLat = locationInfo.location.latitude;
                const staffLng = locationInfo.location.longitude;
                const locationSource = locationInfo.source; // 'browser' or 'profile'

                console.log(`Staff accessing duty ${duty._id} - using ${locationSource} location:`, {
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

                    console.log(`Processing distance for duty ${duty._id}:`, {
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

                        console.log(`Distance calculation completed for duty ${duty._id}:`, {
                            method: distanceInfo.source,
                            distance: distanceInfo.distanceText,
                            duration: distanceInfo.durationText,
                            locationSource: locationSource
                        });

                        // Convert duty to plain object and add distance information
                        const dutyObject = duty.toObject();
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
            console.log('Entering hospital block - CONDITIONAL distance calculation');
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
                    console.log(`Hospital viewing assigned duty ${duty._id} - calculating staff distance`);

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

                    console.log(`Hospital distance calculated for duty ${duty._id}:`, {
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
                    const review = await Review.findOne({ duty: dutyId })
                        .select('rating review createdAt');
                    dutyObject.review = review ? {
                        rating: review.rating,
                        review: review.review,
                        reviewedAt: review.createdAt
                    } : null;

                    return dutyObject;
                } catch (distanceError) {
                    console.error(`Hospital distance calculation failed for duty ${duty._id}:`, distanceError.message);
                }
            }

            console.log(`Hospital viewing duty ${duty._id} - no distance calculation (status: ${duty.status})`);
        } else if (userRole === 'admin') {
            // Admin can view any duty — fall through to return below
        } else {
            throw new ForbiddenError('Access denied: insufficient role to view duty details');
        }

        // For hospital users (or when distance calculation fails), add review data and return
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
    async getAvailableJobsWithDistance(staffId, filters = {}) {
        try {
            // Get staff location using new dashboard service
            const locationInfo = await DashboardService.getStaffLocationForDuties(staffId);

            const staffLat = locationInfo.location.latitude;
            const staffLng = locationInfo.location.longitude;
            const locationSource = locationInfo.source;

            console.log(`Using ${locationSource} location for staff ${staffId}:`, {
                lat: staffLat,
                lng: staffLng,
                permissionGranted: locationInfo.permissionGranted
            });

            // Get staff information for role filtering
            const staff = await MedicalStaff.findOne({ user: staffId });
            if (!staff) {
                throw new NotFoundError('Staff profile not found');
            }

            console.log(`Processing available duties for staff ${staffId}:`, {
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
                        // hospitalLocation: {
                        //     latitude: hospitalLat,
                        //     longitude: hospitalLng,
                        //     address: {
                        //         currentAddress: duty.hospital.currentAddress,
                        //         city: duty.hospital.city,
                        //         state: duty.hospital.state,
                        //         pincode: duty.hospital.pincode
                        //     }
                        // }
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
            throw error;
        }
    }



    async getJobRouteInfo(dutyId, staffId, currentLocation) {
        try {
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
                throw new AppError('Unable to get route information. Please try again.', 503);
            }
        } catch (error) {
            throw error;
        }
    }



    async getCompletedDutiesForStaff(staffUserId, page = 1, limit = 10, statusFilter = null) {
        const TERMINAL_STATUSES = ['completed', 'cancelled', 'incomplete'];

        if (statusFilter && !TERMINAL_STATUSES.includes(statusFilter)) {
            throw new ValidationError(`Invalid status filter. Allowed values: ${TERMINAL_STATUSES.join(', ')}`);
        }

        try {
            const staff = await MedicalStaff.findOne({ user: staffUserId });
            if (!staff) {
                throw new NotFoundError('Medical staff profile not found');
            }

            const paginationParams = getPaginationParams(page, limit);

            const statusQuery = statusFilter ? statusFilter : { $in: TERMINAL_STATUSES };

            const totalDuties = await Duty.countDocuments({
                assignedTo: staff._id,
                status: statusQuery
            });

            const duties = await Duty.find({
                assignedTo: staff._id,
                status: statusQuery
            })
                .populate('hospital', 'hospitalLegalName currentAddress city state pincode')
                .populate({
                    path: 'assignedTo',
                    populate: {
                        path: 'user',
                        select: 'name email role'
                    }
                })
                .sort({ completedAt: -1, cancelledAt: -1, expiredAt: -1, incompleteAt: -1 })
                .skip(paginationParams.skip)
                .limit(paginationParams.limit);

            // Fetch reviews for completed duties only (in single batch query)
            const dutyIds = duties.map(duty => duty._id);
            const reviews = await Review.find({
                duty: { $in: dutyIds }
            }).select('duty rating review createdAt');

            const reviewMap = {};
            reviews.forEach(review => {
                reviewMap[review.duty.toString()] = review;
            });

            let totalHours = 0;
            let totalEarnings = 0;
            let lastDutyDate = null;

            const dutiesWithDetails = duties.map(duty => {
                const duration = calculateDutyDuration(
                    duty.date,
                    duty.startTime,
                    duty.endTime,
                    duty.isOvernightDuty,
                    duty.endDate
                );

                // Only accumulate hours and earnings for completed duties
                if (duty.status === 'completed') {
                    totalHours += duration;
                    totalEarnings += duty.totalPayment || 0;
                }

                // Use the most relevant status timestamp for lastDutyDate
                const dutyTimestamp = duty.completedAt || duty.cancelledAt || duty.expiredAt || duty.incompleteAt;
                if (!lastDutyDate || dutyTimestamp > lastDutyDate) {
                    lastDutyDate = dutyTimestamp;
                }

                return {
                    _id: duty._id,
                    hospital: duty.hospital,
                    assignedTo: duty.assignedTo,
                    staffRole: duty.staffRole,
                    dutySubType: duty.dutySubType,
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
                    completedAt: duty.completedAt || null,
                    cancelledAt: duty.cancelledAt || null,
                    expiredAt: duty.expiredAt || null,
                    incompleteAt: duty.incompleteAt || null,
                    cancellation: duty.cancellation || null,
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
            throw error;
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
            if (!duty) throw new NotFoundError('Duty not found');

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
                },
                payment: {
                    method: duty.paymentMethod || 'Unconfirmed',
                    status: duty.isPaid === true ? 'Paid' : duty.isPaid === false ? 'Will Pay Later' : 'Unconfirmed by hospital',
                    attestedAt: duty.paymentAttestedAt || null
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

    /**
     * Check for duties unassigned for 15 minutes and notify hospital (HIGH)
     */
    async checkUnassigned15MinDuties() {
        const istNow = getCurrentIST();
        const fifteenMinAgo = new Date(istNow.getTime() - 15 * 60 * 1000);
        const sixteenMinAgo = new Date(istNow.getTime() - 16 * 60 * 1000);

        // Duties still 'available' created between 15-16 minutes ago (1-min window to avoid repeat)
        const duties = await Duty.find({
            status: 'available',
            createdAt: { $gte: sixteenMinAgo, $lte: fifteenMinAgo },
            unassigned15MinNotified: { $ne: true }
        }).populate('hospital', 'hospitalLegalName user location currentAddress');

        if (duties.length === 0) return 0;

        let notified = 0;

        for (const duty of duties) {
            try {
                if (!duty.hospital?.user) continue;
                const hospitalUserId = duty.hospital.user._id?.toString() || duty.hospital.user.toString();

                await notificationEmitter.emitDutyUnassigned15Min(duty, hospitalUserId);

                // Mark as notified to prevent duplicates
                await Duty.updateOne({ _id: duty._id }, { $set: { unassigned15MinNotified: true } });
                notified++;
            } catch (err) {
                console.error(`Error sending 15-min unassigned notification for duty ${duty._id}:`, err);
            }
        }

        return notified;
    }

    /**
     * Check for duties still unassigned 30 minutes before shift start and notify hospital (CRITICAL)
     */
    async checkUnfilledCriticalDuties() {
        const istNow = getCurrentIST();

        // Find all available duties today
        const istToday = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());
        const duties = await Duty.find({
            status: 'available',
            date: {
                $gte: istToday,
                $lt: new Date(istToday.getTime() + 24 * 60 * 60 * 1000)
            },
            unfilledCriticalNotified: { $ne: true }
        }).populate('hospital', 'hospitalLegalName user location currentAddress');

        if (duties.length === 0) return 0;

        let notified = 0;

        for (const duty of duties) {
            try {
                if (!duty.hospital?.user) continue;

                const [startHours, startMinutes] = duty.startTime.split(':').map(Number);
                const dutyStartDate = new Date(duty.date);
                const istDutyDate = toIST(dutyStartDate);
                const istDutyStartTime = new Date(istDutyDate);
                istDutyStartTime.setHours(startHours, startMinutes, 0, 0);

                const minutesToShift = Math.floor((istDutyStartTime - istNow) / (1000 * 60));

                // Notify in the 29-31 minute window before shift start
                if (minutesToShift >= 29 && minutesToShift <= 31) {
                    const hospitalUserId = duty.hospital.user._id?.toString() || duty.hospital.user.toString();

                    await notificationEmitter.emitDutyUnfilledCritical(duty, hospitalUserId, minutesToShift);

                    // Mark as notified to prevent duplicates
                    await Duty.updateOne({ _id: duty._id }, { $set: { unfilledCriticalNotified: true } });
                    notified++;
                }
            } catch (err) {
                console.error(`Error sending critical unfilled notification for duty ${duty._id}:`, err);
            }
        }

        return notified;
    }




    // Get active duties for hospital with filtering and real-time tracking
    async getHospitalActiveDuties(hospitalId, filters = {}) {
        try {
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
        } catch (error) {
            throw error;
        }
    }



    // Get duty route map with polyline for hospital (hospital-specific)
    async getHospitalDutyRouteMap(dutyId, hospitalId) {
        try {
            // Verify duty belongs to hospital
            const duty = await Duty.findOne({
                _id: dutyId,
                hospital: hospitalId
            })
                .populate({
                    path: 'assignedTo',
                    select: 'fullName user coordinates phoneNumber skills averageRating experience currentAddress city state pincode email verificationStatus education profileSummary',
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
        } catch (error) {
            throw error;
        }
    }



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
                    const key = `hospilink:staff_location:${staff.user._id}`;
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

            // Return hospital-specific route map
            return {
                staff: {
                    name: staff.fullName,
                    email: staff.user?.email || staff.email,
                    mobileNumber: staff.phoneNumber,
                    skills: staff.skills || [],
                    avgRating: staff.averageRating || 0,
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
    }

    /**
     * Auto-escalate: flag unassigned duties starting within 1 hour for admin attention.
     * Does NOT mutate urgency — uses unfilledCriticalNotified as the escalation flag.
     * Returns count and duty objects so the cron can notify admins.
     */
    async autoEscalateUnassignedDuties() {
        const istNow = getCurrentIST();
        const oneHourLater = new Date(istNow.getTime() + 60 * 60 * 1000);

        // Find available (unassigned) duties not yet flagged for escalation
        const candidates = await Duty.find({
            status: 'available',
            assignedTo: null,
            unfilledCriticalNotified: false
        }).populate('hospital', 'hospitalLegalName name user');

        const toEscalate = [];

        for (const duty of candidates) {
            const [h, m] = duty.startTime.split(':').map(Number);
            const istDutyDate = toIST(new Date(duty.date));
            const dutyStart = new Date(istDutyDate);
            dutyStart.setHours(h, m, 0, 0);

            if (dutyStart > istNow && dutyStart <= oneHourLater) {
                toEscalate.push(duty);
            }
        }

        if (toEscalate.length === 0) return { count: 0, duties: [] };

        const ids = toEscalate.map(d => d._id);
        // Only mark as notified — urgency stays untouched
        await Duty.updateMany(
            { _id: { $in: ids } },
            { $set: { unfilledCriticalNotified: true } }
        );

        return { count: toEscalate.length, duties: toEscalate };
    }

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
                { unfilledCriticalNotified: true }   // auto-escalated unassigned duties
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



    async assignDutyByAdmin({ hospitalId, dutyId, staffId, adminId }) {

        // 1. Hospital validation
        const hospital = await Hospital.findById(hospitalId);
        if (!hospital) {
            throw new NotFoundError('Hospital not found');
        }

        // 2. Duty validation
        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        // 3. Check duty belongs to hospital
        if (duty.hospital.toString() !== hospitalId) {
            throw new UnprocessableEntityError('Duty does not belong to this hospital');
        }

        // 4. Only one staff can take duty
        if (duty.status !== 'available') {
            throw new ConflictError('Duty is already assigned or not available');
        }

        // 5. Staff validation
        const staff = await MedicalStaff.findById(staffId);
        if (!staff) {
            throw new NotFoundError('Medical staff not found');
        }

        // 6. Role match
        const normalizedStaffRole = normalizeRole(staff.jobRole);
        const normalizedDutyRole = normalizeRole(duty.staffRole);

        if (normalizedStaffRole !== normalizedDutyRole) {
            throw new UnprocessableEntityError(`Role mismatch: duty requires ${duty.staffRole}`);
        }

        // 7. Time validation (same as hospital)
        const now = getCurrentIST();
        const dutyDate = new Date(duty.date);
        const [startHours, startMinutes] = duty.startTime.split(':');

        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);

        if (now >= dutyStartTime) {
            throw new UnprocessableEntityError('Cannot assign duty after start time');
        }

        // 8. Overlap check 
        const existingDuties = await Duty.find({
            assignedTo: staff._id,
            status: 'assigned',
            $or: [
                { date: duty.date },
                ...(duty.isOvernightDuty && duty.endDate ? [{ date: duty.endDate }] : [])
            ]
        });

        for (const existing of existingDuties) {
            if (doDutiesOverlap(duty, existing)) {
                throw new ConflictError('Staff already has overlapping duty');
            }
        }

        // 9. Assign duty
        duty.status = 'assigned';
        duty.assignedTo = staff._id;
        duty.assignedAt = getCurrentIST();

        duty.statusHistory.push({
            status: 'assigned',
            timestamp: getCurrentIST(),
            changedBy: adminId,
            reason: 'Assigned by admin'
        });

        await duty.save();

        await duty.populate({
            path: 'assignedTo',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        return duty;
    }



    // Staff taps "Get OTP to mark as in-progress" once they're within range of the hospital.
    // Re-checks the geofence server-side against the submitted coordinates, mints a Start OTP,
    // and sends it via SMS to the hospital's registered phone number. The hospital reads the
    // code aloud to the staff member, who then submits it via verify-start-otp.
    async requestStartOtp(dutyId, userId, coordinates) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId).populate('hospital');
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
            throw new ForbiddenError('You can only request a start OTP for duties assigned to you');
        }

        // Idempotency: already verified and moved to in-progress
        if (duty.status === 'in-progress' && duty.startOtp.status === 'VERIFIED') {
            return { duty, alreadyInProgress: true, expiresAt: null };
        }

        if (duty.status !== 'enroute') {
            throw new ValidationError('Duty must be enroute before requesting a start OTP');
        }

        if (duty.startOtp.status === 'LOCKED') {
            throw new ForbiddenError('Start OTP is locked — contact admin support');
        }

        // Time-window guard: OTP can only be requested within ±bufferMinutes of scheduled start.
        // Enforced at generation — never issue a code when the check-in window is closed.
        const now = getCurrentIST();
        const bufferMinutes = 15;
        const [startHours, startMinutes] = duty.startTime.split(':').map(Number);
        const istDutyDate = toIST(new Date(duty.date));
        const scheduledStartTime = new Date(istDutyDate);
        scheduledStartTime.setHours(startHours, startMinutes, 0, 0);

        const windowStart = new Date(scheduledStartTime.getTime() - bufferMinutes * 60 * 1000);
        const windowEnd   = new Date(scheduledStartTime.getTime() + bufferMinutes * 60 * 1000);

        if (now < windowStart) {
            const opensAt  = windowStart.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
            const startsAt = scheduledStartTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
            throw new ValidationError(
                `Check-in window has not opened yet. You can request a start OTP from ${opensAt} (${bufferMinutes} minutes before your ${startsAt} duty start).`
            );
        }

        if (now > windowEnd) {
            const windowStartStr = windowStart.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
            const windowEndStr   = windowEnd.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
            throw new ValidationError(
                `Check-in window has closed. The start OTP window was ${windowStartStr} – ${windowEndStr}. Please contact admin if you need assistance.`
            );
        }

        const hospitalLat = duty.hospital?.coordinates?.coordinates?.latitude;
        const hospitalLng = duty.hospital?.coordinates?.coordinates?.longitude;
        if (typeof hospitalLat !== 'number' || typeof hospitalLng !== 'number') {
            throw new ValidationError('Hospital location is not configured — contact support');
        }

        if (!isWithinGeofence(coordinates.latitude, coordinates.longitude, hospitalLat, hospitalLng)) {
            const radiusMeters = Math.round(GEOFENCE_RADIUS_KM * 1000);
            throw new ValidationError(`You must be within ${radiusMeters}m of the hospital to request a start OTP`);
        }

        const code = OTPService.generateOTP();
        const expiryMinutes = parseInt(process.env.DUTY_START_OTP_EXPIRY_MINUTES) || 5;
        const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000);

        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: 'enroute' },
            {
                $set: {
                    'startOtp.code': code,
                    'startOtp.expiresAt': expiresAt,
                    'startOtp.attempts': 0,
                    'startOtp.status': 'PENDING',
                    'startOtp.sentAt': now
                }
            },
            { new: true }
        );

        if (!updated) {
            throw new ConflictError('Duty status changed — cannot request start OTP');
        }

        await this._sendHospitalOtpSms(duty.hospital, code, dutyId);

        return { duty: updated, alreadyInProgress: false, expiresAt: updated.startOtp.expiresAt };
    }



    // Sends an OTP code to the staff member's own registered phone via SMS. Failures are
    // logged but never thrown — OTP delivery issues shouldn't block the request/response.
    async _sendStaffOtpSms(medicalStaff, code, dutyId, otpType) {
        if (!medicalStaff?.phoneNumber) {
            return;
        }
        try {
            await SMSService.sendOTPSMS(medicalStaff.phoneNumber, code, medicalStaff.fullName);
        } catch (smsError) {
            console.error(`Error sending ${otpType} OTP SMS for duty ${dutyId}:`, smsError);
        }
    }

    // Sends a Start OTP to the hospital's registered phone via SMS so the hospital can read
    // it aloud to the arriving staff member. Failures are logged but never thrown.
    async _sendHospitalOtpSms(hospital, code, dutyId) {
        if (!hospital?.phoneNumber) {
            return;
        }
        try {
            await SMSService.sendOTPSMS(hospital.phoneNumber, code, hospital.hospitalLegalName);
        } catch (smsError) {
            console.error(`Error sending start OTP SMS to hospital for duty ${dutyId}:`, smsError);
        }
    }



    // Staff submits the Start OTP (read out by the hospital) along with their current
    // coordinates. Both the OTP and a fresh geofence check must pass to move 'enroute' ->
    // 'in-progress'. Wrong OTP or out-of-range counts toward the shared lockout counter.
    async verifyStartOtp(dutyId, userId, otp, coordinates) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId).populate('hospital');
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
            throw new ForbiddenError('You can only verify OTP for duties assigned to you');
        }

        // Idempotency: already verified and moved to in-progress
        if (duty.status === 'in-progress' && duty.startOtp.status === 'VERIFIED') {
            return duty;
        }

        if (duty.status !== 'enroute') {
            throw new ValidationError('Duty must be enroute before verifying start OTP');
        }

        if (duty.startOtp.status === 'LOCKED') {
            throw new ForbiddenError('Start OTP is locked — contact admin support');
        }

        if (duty.startOtp.status !== 'PENDING' || !duty.startOtp.expiresAt || duty.startOtp.expiresAt <= getCurrentIST()) {
            if (duty.startOtp.status === 'PENDING') {
                await Duty.updateOne({ _id: dutyId }, { $set: { 'startOtp.status': 'EXPIRED' } });
            }
            throw new ValidationError('No active start OTP — move within range of the hospital to trigger one');
        }

        const hospitalLat = duty.hospital?.coordinates?.coordinates?.latitude;
        const hospitalLng = duty.hospital?.coordinates?.coordinates?.longitude;
        if (typeof hospitalLat !== 'number' || typeof hospitalLng !== 'number') {
            throw new ValidationError('Hospital location is not configured — contact support');
        }

        const geofenceOk = isWithinGeofence(coordinates.latitude, coordinates.longitude, hospitalLat, hospitalLng);
        const otpOk = duty.startOtp.code === otp;

        if (!geofenceOk || !otpOk) {
            const attempts = duty.startOtp.attempts + 1;
            const maxAttempts = parseInt(process.env.DUTY_OTP_MAX_ATTEMPTS) || 5;
            const updateFields = { 'startOtp.attempts': attempts };
            if (attempts >= maxAttempts) {
                updateFields['startOtp.status'] = 'LOCKED';
            }
            await Duty.updateOne({ _id: dutyId }, { $set: updateFields });

            const reasons = [];
            if (!otpOk) reasons.push('incorrect OTP');
            if (!geofenceOk) reasons.push('you are not within range of the hospital');

            if (attempts >= maxAttempts) {
                throw new ForbiddenError(`Verification failed (${reasons.join(' and ')}). Start OTP is now locked — contact admin support.`);
            }
            throw new ValidationError(`Verification failed: ${reasons.join(' and ')}. ${maxAttempts - attempts} attempt(s) remaining.`);
        }

        const now = getCurrentIST();
        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: 'enroute' },
            {
                $set: {
                    status: 'in-progress',
                    startedAt: now,
                    'startOtp.status': 'VERIFIED'
                },
                $push: {
                    statusHistory: {
                        status: 'in-progress',
                        timestamp: now,
                        changedBy: medicalStaff._id,
                        reason: 'Start OTP verified — duty started'
                    }
                }
            },
            { new: true }
        )
            .populate({
                path: 'hospital',
                populate: { path: 'user', select: 'name email' }
            })
            .populate({
                path: 'assignedTo',
                populate: { path: 'user', select: 'name email' }
            });

        if (!updated) {
            throw new ConflictError('Duty status changed before verification could complete — please retry');
        }

        return updated;
    }



    // Staff requests an End OTP once the duty is in-progress and the scheduled end time has
    // arrived. The code is sent via SMS to the staff's own registered phone number (never
    // returned in the response) and read out to the hospital, who enters it via verifyEndOtp.
    async requestEndOtp(dutyId, userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
            throw new ForbiddenError('You can only request an end OTP for duties assigned to you');
        }

        // Idempotency: an active OTP already exists — resend the same code via SMS
        if (duty.status === 'in-progress' && duty.endOtp.status === 'PENDING' && duty.endOtp.expiresAt > getCurrentIST()) {
            await this._sendStaffOtpSms(medicalStaff, duty.endOtp.code, dutyId, 'end');
            return { expiresAt: duty.endOtp.expiresAt };
        }

        if (duty.endOtp.status === 'LOCKED') {
            throw new ForbiddenError('End OTP is locked — contact admin support');
        }

        const validation = duty.canRequestEndOtp();
        if (!validation.allowed) {
            throw new ValidationError(validation.reason);
        }

        const code = OTPService.generateOTP();
        const expiryMinutes = parseInt(process.env.DUTY_END_OTP_EXPIRY_MINUTES) || 30;
        const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
        const now = getCurrentIST();

        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: 'in-progress' },
            {
                $set: {
                    'endOtp.code': code,
                    'endOtp.expiresAt': expiresAt,
                    'endOtp.attempts': 0,
                    'endOtp.status': 'PENDING',
                    'endOtp.sentAt': now
                }
            },
            { new: true }
        );

        if (!updated) {
            throw new ConflictError('Duty status changed — cannot request end OTP');
        }

        await this._sendStaffOtpSms(medicalStaff, code, dutyId, 'end');

        return { expiresAt: updated.endOtp.expiresAt };
    }



    // Hospital enters the End OTP (read out by the staff) along with a payment attestation
    // (method + paid/unpaid). Moves 'in-progress'/'pending-confirmation' -> 'completed'.
    async verifyEndOtp(dutyId, hospitalUserId, otp, paymentMethod, isPaid) {
        const hospital = await Hospital.findOne({ user: hospitalUserId });
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId).populate('hospital');
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (duty.hospital._id.toString() !== hospital._id.toString()) {
            throw new ForbiddenError('You can only verify OTP for your own duties');
        }

        // Idempotency: already completed via end OTP
        if (duty.status === 'completed' && duty.endOtp.status === 'VERIFIED') {
            return Duty.findById(dutyId)
                .populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } })
                .populate({ path: 'assignedTo', populate: { path: 'user', select: 'name email' } });
        }

        const validation = duty.canVerifyEndOtp();
        if (!validation.allowed) {
            if (duty.endOtp.status === 'LOCKED') {
                throw new ForbiddenError(validation.reason);
            }
            if (duty.endOtp.status === 'PENDING' && (!duty.endOtp.expiresAt || duty.endOtp.expiresAt <= getCurrentIST())) {
                await Duty.updateOne({ _id: dutyId }, { $set: { 'endOtp.status': 'EXPIRED' } });
            }
            throw new ValidationError(validation.reason);
        }

        const otpOk = duty.endOtp.code === otp;

        if (!otpOk) {
            const attempts = duty.endOtp.attempts + 1;
            const maxAttempts = parseInt(process.env.DUTY_OTP_MAX_ATTEMPTS) || 5;
            const updateFields = { 'endOtp.attempts': attempts };
            if (attempts >= maxAttempts) {
                updateFields['endOtp.status'] = 'LOCKED';
            }
            await Duty.updateOne({ _id: dutyId }, { $set: updateFields });

            if (attempts >= maxAttempts) {
                throw new ForbiddenError('Incorrect OTP. End OTP is now locked — contact admin support.');
            }
            throw new ValidationError(`Incorrect OTP. ${maxAttempts - attempts} attempt(s) remaining.`);
        }

        const now = getCurrentIST();
        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: { $in: ['in-progress', 'pending-confirmation'] } },
            {
                $set: {
                    status: 'completed',
                    completedAt: now,
                    paymentMethod,
                    isPaid,
                    paymentAttestedAt: now,
                    paymentAttestedBy: hospitalUserId,
                    'endOtp.status': 'VERIFIED'
                },
                $push: {
                    statusHistory: {
                        status: 'completed',
                        timestamp: now,
                        changedBy: hospitalUserId,
                        reason: 'End OTP verified by hospital — duty completed'
                    }
                }
            },
            { new: true }
        )
            .populate({
                path: 'hospital',
                populate: { path: 'user', select: 'name email' }
            })
            .populate({
                path: 'assignedTo',
                populate: { path: 'user', select: 'name email' }
            });

        if (!updated) {
            throw new ConflictError('Duty status changed before verification could complete — please retry');
        }

        return updated;
    }



    // Re-mints the End OTP — used when the original expired, or staff never tapped "End Duty"
    // and the duty fell into 'pending-confirmation'. Either staff (who reads the code) or
    // hospital (who enters it) may trigger this; the new code is sent via SMS to the staff's
    // own registered phone (never returned in the response or an in-app notification).
    async regenerateEndOtp(dutyId, userId, userRole) {
        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (userRole === 'staff') {
            const medicalStaff = await MedicalStaff.findOne({ user: userId });
            if (!medicalStaff || !duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
                throw new ForbiddenError('You can only regenerate OTP for duties assigned to you');
            }
        } else if (userRole === 'hospital') {
            const hospital = await Hospital.findOne({ user: userId });
            if (!hospital || duty.hospital.toString() !== hospital._id.toString()) {
                throw new ForbiddenError('You can only regenerate OTP for your own duties');
            }
        }

        if (!['in-progress', 'pending-confirmation'].includes(duty.status)) {
            throw new ValidationError('End OTP can only be regenerated while the duty is in progress or pending confirmation');
        }

        if (duty.endOtp.status === 'LOCKED') {
            throw new ForbiddenError('End OTP is locked — contact admin support');
        }

        if (duty.endOtp.status === 'PENDING' && duty.endOtp.expiresAt && duty.endOtp.expiresAt > getCurrentIST()) {
            throw new ValidationError('An end OTP is still active — wait for it to expire before requesting a new one');
        }

        const code = OTPService.generateOTP();
        const expiryMinutes = parseInt(process.env.DUTY_END_OTP_EXPIRY_MINUTES) || 30;
        const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
        const now = getCurrentIST();

        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: { $in: ['in-progress', 'pending-confirmation'] } },
            {
                $set: {
                    'endOtp.code': code,
                    'endOtp.expiresAt': expiresAt,
                    'endOtp.attempts': 0,
                    'endOtp.status': 'PENDING',
                    'endOtp.sentAt': now
                }
            },
            { new: true }
        ).populate({
            path: 'assignedTo',
            populate: { path: 'user', select: 'name email' }
        });

        if (!updated) {
            throw new ConflictError('Duty status changed — cannot regenerate end OTP');
        }

        // The new code is only ever sent via SMS to staff's own phone — they read it out to the hospital
        await this._sendStaffOtpSms(updated.assignedTo, code, dutyId, 'end');

        // Notify staff in-app that a fresh OTP was sent (without exposing the code)
        if (updated.assignedTo?.user?._id) {
            notificationEmitter.emitEndOtpRegenerated(
                updated,
                updated.assignedTo.user._id.toString(),
                expiresAt
            ).catch(err => console.error(`Error sending end OTP regenerated notification for duty ${dutyId}:`, err));
        }

        return { expiresAt: updated.endOtp.expiresAt };
    }



    // Either party (staff or hospital) raises a dispute on a duty that's awaiting hospital
    // confirmation, or was recently completed (within DUTY_DISPUTE_WINDOW_HOURS).
    async raiseDispute(dutyId, userId, userRole, reason) {
        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (userRole === 'staff') {
            const medicalStaff = await MedicalStaff.findOne({ user: userId });
            if (!medicalStaff || !duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
                throw new ForbiddenError('You can only raise a dispute for duties assigned to you');
            }
        } else if (userRole === 'hospital') {
            const hospital = await Hospital.findOne({ user: userId });
            if (!hospital || duty.hospital.toString() !== hospital._id.toString()) {
                throw new ForbiddenError('You can only raise a dispute for your own duties');
            }
        } else {
            throw new ForbiddenError('Only staff or hospital can raise a dispute');
        }

        if (!['pending-confirmation', 'completed'].includes(duty.status)) {
            throw new ValidationError('A dispute can only be raised while a duty is pending confirmation or recently completed');
        }

        if (duty.status === 'completed') {
            const windowHours = parseInt(process.env.DUTY_DISPUTE_WINDOW_HOURS) || 48;
            const windowEnd = new Date((duty.completedAt || duty.updatedAt).getTime() + windowHours * 60 * 60 * 1000);
            if (getCurrentIST() > windowEnd) {
                throw new ValidationError(`Completed duties can only be disputed within ${windowHours} hours of completion`);
            }
        }

        const now = getCurrentIST();
        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: duty.status },
            {
                $set: {
                    status: 'disputed',
                    disputedAt: now,
                    disputeRaisedBy: userId,
                    disputeRaisedByRole: userRole,
                    disputeReason: reason
                },
                $push: {
                    statusHistory: {
                        status: 'disputed',
                        timestamp: now,
                        changedBy: userId,
                        reason: `Dispute raised by ${userRole}: ${reason}`
                    }
                }
            },
            { new: true }
        )
            .populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } })
            .populate({ path: 'assignedTo', populate: { path: 'user', select: 'name email' } });

        if (!updated) {
            throw new ConflictError('Duty status changed — cannot raise dispute');
        }

        return updated;
    }



    // Admin resolves a disputed duty, setting its final status. When resolving to 'completed',
    // an admin may optionally supply/override the payment attestation and completedAt.
    async resolveDispute(dutyId, adminId, { finalStatus, notes, paymentMethod, isPaid, completedAt }) {
        if (!['completed', 'incomplete', 'cancelled'].includes(finalStatus)) {
            throw new ValidationError('finalStatus must be one of: completed, incomplete, cancelled');
        }

        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (duty.status !== 'disputed') {
            throw new ValidationError('Only disputed duties can be resolved');
        }

        const now = getCurrentIST();
        const setFields = {
            disputeResolution: {
                resolvedBy: adminId,
                resolvedAt: now,
                notes: notes || null,
                finalStatus
            },
            status: finalStatus
        };

        if (finalStatus === 'completed') {
            setFields.completedAt = completedAt ? new Date(completedAt) : (duty.completedAt || now);
            if (paymentMethod !== undefined) setFields.paymentMethod = paymentMethod;
            if (isPaid !== undefined) setFields.isPaid = isPaid;
            if (paymentMethod !== undefined || isPaid !== undefined) {
                setFields.paymentAttestedAt = now;
                setFields.paymentAttestedBy = adminId;
            }
        } else if (finalStatus === 'incomplete') {
            setFields.incompleteAt = now;
        }

        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: 'disputed' },
            {
                $set: setFields,
                $push: {
                    statusHistory: {
                        status: finalStatus,
                        timestamp: now,
                        changedBy: adminId,
                        reason: `Dispute resolved by admin: ${notes || finalStatus}`
                    }
                }
            },
            { new: true }
        )
            .populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } })
            .populate({ path: 'assignedTo', populate: { path: 'user', select: 'name email' } });

        if (!updated) {
            throw new ConflictError('Duty status changed — cannot resolve dispute');
        }

        return updated;
    }



    // Admin unlocks a locked start/end OTP, resetting it to 'NONE' so the normal
    // trigger/request flow re-mints a fresh code.
    async unlockDutyOtp(dutyId, otpType, adminId, reason) {
        if (!['start', 'end'].includes(otpType)) {
            throw new ValidationError("otpType must be 'start' or 'end'");
        }

        const field = `${otpType}Otp`;

        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (duty[field].status !== 'LOCKED') {
            throw new ValidationError(`${otpType === 'start' ? 'Start' : 'End'} OTP is not locked`);
        }

        const now = getCurrentIST();
        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, [`${field}.status`]: 'LOCKED' },
            {
                $set: {
                    [`${field}.status`]: 'NONE',
                    [`${field}.attempts`]: 0,
                    [`${field}.unlockedBy`]: adminId,
                    [`${field}.unlockReason`]: reason
                },
                $push: {
                    statusHistory: {
                        status: duty.status,
                        timestamp: now,
                        changedBy: adminId,
                        reason: `${otpType === 'start' ? 'Start' : 'End'} OTP unlocked by admin: ${reason}`
                    }
                }
            },
            { new: true }
        );

        if (!updated) {
            throw new ConflictError('OTP status changed — cannot unlock');
        }

        return updated;
    }
}

module.exports = new DutyService();