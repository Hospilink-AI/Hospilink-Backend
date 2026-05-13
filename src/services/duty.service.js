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
const DashboardService = require('./dashboard.service');
const redisClient = require('../config/redis');
const { getBatchStaffLocations, formatActiveDuty } = require('../utils/activeDuty.helper');
const notificationEmitter = require('./notificationEmitter');


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



    // Duty history for hospital — shaped for the Duty History UI table
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

        if (status) match.status = status;
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
                    durationText: distanceInfo.durationText,
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
        }).populate('hospital', 'hospitalLegalName currentAddress location user')
            .populate('assignedTo');

        // Prepare bulk operations
        const bulkOps = [];
        const dutiesForNotification = []; // Track duties that will be completed

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

                // Store duty info for notification
                dutiesForNotification.push(duty);
            }
        }

        // Execute bulk operations if any
        let completedCount = 0;
        if (bulkOps.length > 0) {
            const result = await Duty.bulkWrite(bulkOps);
            completedCount = result.modifiedCount;

            // Send notifications for auto-completed duties
            if (completedCount > 0 && dutiesForNotification.length > 0) {
                for (const duty of dutiesForNotification) {
                    try {
                        // Get staff details
                        const staff = await MedicalStaff.findById(duty.assignedTo._id || duty.assignedTo)
                            .populate('user', 'name');

                        if (staff && duty.hospital && duty.hospital.user) {
                            const hospitalUserId = duty.hospital.user._id?.toString() || duty.hospital.user.toString();

                            // Emit duty completed notification to hospital
                            await notificationEmitter.emitDutyCompleted(duty, staff, hospitalUserId);
                            console.log(`Auto-complete notification sent for duty ${duty._id}`);
                        }
                    } catch (notifError) {
                        console.error(`Error sending auto-complete notification for duty ${duty._id}:`, notifError);
                        // Continue with other notifications even if one fails
                    }
                }
            }
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

        const isEmergencyOrCritical = duty.urgency === 'emergency';
        const isPricingOnlyUpdate = updateData.offeredRate !== undefined &&
            Object.keys(updateData).every(k => k === 'offeredRate');

        // For emergency duties: allow pricing-only edit until 1 min before start
        if (isEmergencyOrCritical && isPricingOnlyUpdate) {
            const pricingValidation = duty.canEditPricing();
            if (!pricingValidation.allowed) {
                throw new Error(pricingValidation.reason);
            }
            duty.offeredRate = updateData.offeredRate;
            await duty.save();
            await duty.populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } });
            return duty;
        }

        // Standard edit: check 30-minute rule
        const editValidation = duty.canEditDuty();
        if (!editValidation.allowed) {
            // For emergency, give a more specific error
            if (isEmergencyOrCritical) {
                throw new Error('Emergency duties can only have their pricing edited. Use offeredRate only.');
            }
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
                throw new Error('Hospital profile not found');
            }

            // Hospital can only view their own duties
            if (duty.hospital._id.toString() !== hospital._id.toString()) {
                throw new Error('Access denied: You can only view your hospital duties');
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
        } else {
            console.log(`Unknown user role: "${userRole}"`);
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
                throw new Error('Staff profile not found');
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
            throw new Error(error.message);
        }
    }



    async getJobRouteInfo(dutyId, staffId, currentLocation) {
        try {
            // Get duty details
            const duty = await Duty.findById(dutyId).populate('hospital', 'hospitalLegalName currentAddress city state pincode coordinates');

            if (!duty) {
                throw new Error('Duty not found');
            }

            // Add proper null check before accessing location properties
            if (!currentLocation || !currentLocation.latitude || !currentLocation.longitude) {
                throw new Error('Staff location is required to get route information. Please enable location in your dashboard or update your profile location.');
            }

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
                .populate('hospital', 'hospitalLegalName currentAddress city state pincode')
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
                const allowedRoles = [
                    'rmo', 'dmo', 'general_physician', 'intensivist', 'emergency_doctor',
                    'anesthetist', 'pediatrician', 'gynecologist', 'orthopedic_surgeon',
                    'general_surgeon', 'radiologist', 'pathologist', 'staff_nurse',
                    'icu_nurse', 'emergency_nurse', 'ot_nurse', 'dialysis_nurse', 'nicu_nurse',
                    'lab_technician', 'radiology_technician', 'ot_technician', 'dialysis_technician',
                    'cath_lab_technician', 'icu_technician', 'ward_boy', 'ayah', 'opd_attendant',
                    'emergency_attendant', 'patient_care_taker', 'pharmacist', 'pharmacy_assistant',
                    'biomedical_engineer', 'housekeeping_staff', 'security_guard', 'ambulance_driver',
                    'receptionist', 'billing_executive', 'medical_records_staff', 'hr_accounts'
                ];

                if (!allowedRoles.includes(role)) {
                    throw new Error(`Invalid role: ${role}`);
                }
                query.staffRole = role;
            }

            // Add status filter if specified
            if (status) {
                const allowedStatuses = ['assigned', 'enroute', 'in-progress'];
                if (!allowedStatuses.includes(status)) {
                    throw new Error(`Invalid status: ${status}`);
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
                throw new Error('Duty not found or does not belong to your hospital');
            }

            // Verify duty is in active state
            if (!['assigned', 'enroute', 'in-progress'].includes(duty.status)) {
                throw new Error('Duty is not in active state');
            }

            if (!duty.assignedTo) {
                throw new Error('Duty is not assigned to any staff');
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
                throw new Error('Unable to determine staff location');
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
                // Fallback to direct distance calculation
                const distance = geocodingService.calculateStraightLineDistance(
                    currentLocation.latitude,
                    currentLocation.longitude,
                    hospital.coordinates.coordinates.latitude,
                    hospital.coordinates.coordinates.longitude
                );

                routeInfo = {
                    overviewPolyline: null,
                    stepPolylines: [],
                    distance: distance,
                    duration: null,
                    distanceText: `${distance.toFixed(1)} km`,
                    durationText: null,
                    steps: [],
                    source: 'direct_calculation'
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
                    address: duty.hospital?.currentAddress
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
            throw new Error('Hospital not found');
        }

        // 2. Duty validation
        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new Error('Duty not found');
        }

        // 3. Check duty belongs to hospital
        if (duty.hospital.toString() !== hospitalId) {
            throw new Error('Duty does not belong to this hospital');
        }

        // 4. Only one staff can take duty
        if (duty.status !== 'available') {
            throw new Error('Duty is already assigned or not available');
        }

        // 5. Staff validation
        const staff = await MedicalStaff.findById(staffId);
        if (!staff) {
            throw new Error('Medical staff not found');
        }

        // 6. Role match 
        const normalizedStaffRole = normalizeRole(staff.jobRole);
        const normalizedDutyRole = normalizeRole(duty.staffRole);

        if (normalizedStaffRole !== normalizedDutyRole) {
            throw new Error(`Role mismatch: duty requires ${duty.staffRole}`);
        }

        // 7. Time validation (same as hospital)
        const now = getCurrentIST();
        const dutyDate = new Date(duty.date);
        const [startHours, startMinutes] = duty.startTime.split(':');

        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);

        if (now >= dutyStartTime) {
            throw new Error('Cannot assign duty after start time');
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
                throw new Error('Staff already has overlapping duty');
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
}

module.exports = new DutyService();