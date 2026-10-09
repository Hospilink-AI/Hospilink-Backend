// Duties: work the cron jobs run (moving to pending confirmation,
// expiring, marking incomplete, reminders, escalation, relist pushes)
// Methods of DutyService; mixed into the class in ../duty.service.js, so `this` is the service.
const logger = require('../../utils/logger');
const Duty = require('../../models/Duty');
const MedicalStaff = require('../../models/MedicalStaff');
const { toIST, getCurrentIST } = require('../../utils/helpers');
const notificationEmitter = require('../notificationEmitter');
const activityLogEmitter = require('../activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../../utils/activityLog.constants');
const locationBasedStaffService = require('../locationBasedStaff.service');
const dutyOfferService = require('../dutyOffer.service');
const blockService = require('../block.service');
const systemConfigService = require('../systemConfig.service');
const { SYSTEM_ACTOR } = require('./helpers');

module.exports = {
    async moveDutiesToPendingConfirmation() {
        // Use getCurrentIST() for consistent time handling
        const istNow = getCurrentIST();

        // Get today's date in IST
        const istToday = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());

        // From yesterday, so overnight duties that end this morning are included
        const dutiesToComplete = await Duty.find({
            status: 'in-progress',
            date: {
                $gte: new Date(istToday.getFullYear(), istToday.getMonth(), istToday.getDate() - 1),
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
            // Scheduled end, the next day for overnight duties
            const istDutyEndTime = duty.getScheduledEnd();

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
                            activityLogEmitter.emitDutyActivity(ACTIVITY_ACTIONS.DUTY_PENDING_CONFIRMATION, duty, SYSTEM_ACTOR).catch(() => {});
                            logger.debug(`Pending-confirmation notification sent for duty ${duty._id}`);
                        }
                    } catch (notifError) {
                        console.error(`Error sending pending-confirmation notification for duty ${duty._id}:`, notifError);
                        // Continue with other notifications even if one fails
                    }
                }
            }
        }

        return movedCount;
    },

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
        }).select('_id date startTime endTime staffRole urgency offeredRate hospital statusHistory'); // Select only needed fields

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

            // Tell each hospital its duty expired with nobody accepting
            const expired = await Duty.find({ _id: { $in: bulkOps.map(op => op.updateOne.filter._id) }, status: 'expired', expiredAt: istNow })
                .select('date startTime endTime staffRole urgency offeredRate status hospital')
                .populate('hospital', 'user')
                .lean();
            for (const duty of expired) {
                await notificationEmitter.emitDutyNotice('DUTY_EXPIRED_UNFILLED', duty, [duty.hospital?.user],
                    `Nobody accepted your ${notificationEmitter.describeShift(duty)}, so it has expired. You can post it again.`);
                activityLogEmitter.emitDutyActivity(ACTIVITY_ACTIONS.DUTY_EXPIRED, duty, SYSTEM_ACTOR).catch(() => {});
            }
        }

        return expiredCount;
    },

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
        }).populate('hospital', 'hospitalLegalName user')
            .populate({
                path: 'assignedTo',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            });

        const bulkOps = [];
        const incompleteDuties = [];
        const noticeDuties = [];

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

                logger.debug(`Marking duty INCOMPLETE: ${hospitalName} - ${duty.staffRole} - ${staffName} (${minutesOverdue}min overdue)`);

                incompleteDuties.push({
                    dutyId: duty._id,
                    hospitalName,
                    staffName,
                    staffRole: duty.staffRole,
                    startTime: duty.startTime,
                    previousStatus: duty.status,
                    minutesOverdue
                });
                noticeDuties.push(duty);

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

            logger.debug(`\n=== INCOMPLETE DUTIES SUMMARY ===`);
            logger.debug(`Total duties marked incomplete: ${markedIncompleteCount}`);
            incompleteDuties.forEach(duty => {
                logger.debug(`• ${duty.staffName} - ${duty.staffRole} at ${duty.hospitalName} (${duty.minutesOverdue}min overdue)`);
            });
            logger.debug(`================================\n`);

            // Tell both sides the duty was closed as incomplete
            for (const duty of noticeDuties) {
                activityLogEmitter.emitDutyActivity(ACTIVITY_ACTIONS.DUTY_MARKED_INCOMPLETE, duty, SYSTEM_ACTOR, { previousStatus: duty.status }).catch(() => {});
                const shift = notificationEmitter.describeShift(duty);
                const staffName = duty.assignedTo?.fullName || duty.assignedTo?.user?.name || 'The doctor';
                await notificationEmitter.emitDutyNotice('DUTY_MARKED_INCOMPLETE', { ...duty.toObject(), status: 'incomplete' }, [duty.hospital?.user],
                    `${staffName} did not start your ${shift}, so it was marked incomplete. Raise a ticket if something went wrong.`);
                await notificationEmitter.emitDutyNotice('DUTY_MARKED_INCOMPLETE', { ...duty.toObject(), status: 'incomplete' }, [duty.assignedTo?.user?._id],
                    `Your ${shift} at ${duty.hospital?.hospitalLegalName || 'the hospital'} was marked incomplete because it was not started. Raise a ticket if this is wrong.`);
            }
        }

        return markedIncompleteCount;
    },

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
                    logger.debug(`Navigation reminder sent: ${staffName} for duty at ${hospitalName} (starts in ${reminder.minutesUntilStart} min)`);
                } catch (notifError) {
                    console.error(`Error sending navigation reminder for duty ${reminder.duty._id}:`, notifError);
                }
            }
        }

        return remindersToSend.length;
    },

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
                await Duty.updateOne({ _id: duty._id }, { $set: { unassigned15MinNotified: true, unassigned15MinNotifiedAt: new Date() } });
                notified++;
            } catch (err) {
                console.error(`Error sending 15-min unassigned notification for duty ${duty._id}:`, err);
            }
        }

        return notified;
    },

    /**
     * a 2nd notification at +15 min and a 3rd at +45
     * min for a still-unfilled relisted duty, stopping at the staff
     * cancellation cutoff (past that point it's a no-show concern, not a
     * fill-it-faster one). State-based (repeatPushCount vs. minutes-since-
     * last-relist) rather than a narrow createdAt window, since this sweep
     * doesn't need 1-minute precision the way the 15-min-unassigned check
     * does — being a few minutes late off a 5-minute sweep is fine for
     * "urgent rather than annoying."
     */
    async sendAutoRelistRepeatPushes() {
        const now = getCurrentIST();

        // Resolved once per sweep tick, not per duty — systemConfigService
        // caches for 5 minutes anyway, but there's no reason to re-fetch
        // inside the loop below.
        const cfg = await systemConfigService.getManyEffective([
            'autoRelist.staffCancelCutoffMinutes',
            'autoRelist.notificationRadiusKm',
            'autoRelist.repeatPushScheduleMinutes'
        ]);
        const staffCancelCutoffMinutes = cfg['autoRelist.staffCancelCutoffMinutes'];
        const notificationRadiusKm = cfg['autoRelist.notificationRadiusKm'];
        const repeatPushScheduleMinutes = cfg['autoRelist.repeatPushScheduleMinutes'];

        const candidates = await Duty.find({
            status: 'available',
            'autoRelist.enabled': { $ne: false },
            'autoRelist.relistCount': { $gt: 0 },
            'autoRelist.repeatPushCount': { $lt: repeatPushScheduleMinutes.length }
        })
            .populate('hospital', 'hospitalLegalName coordinates')
            .select('staffRole date startTime endTime urgency offeredRate autoRelist hospital');

        let sentCount = 0;

        for (const duty of candidates) {
            try {
                const istDutyDate = toIST(new Date(duty.date));
                const [h, m] = duty.startTime.split(':');
                const dutyStart = new Date(istDutyDate);
                dutyStart.setHours(parseInt(h), parseInt(m), 0, 0);
                const minutesUntilStart = (dutyStart.getTime() - now.getTime()) / (60 * 1000);

                // Inside the cutoff — stop pushing; this is a no-show concern now.
                if (minutesUntilStart < staffCancelCutoffMinutes) continue;

                const history = duty.autoRelist.history || [];
                const lastEntry = history[history.length - 1];
                if (!lastEntry) continue;

                const minutesSinceRelist = (now.getTime() - new Date(lastEntry.timestamp).getTime()) / (60 * 1000);

                let targetPushCount = 0;
                for (let i = 0; i < repeatPushScheduleMinutes.length; i++) {
                    if (minutesSinceRelist >= repeatPushScheduleMinutes[i]) targetPushCount = i + 1;
                }

                if (targetPushCount <= duty.autoRelist.repeatPushCount) continue;

                const hospitalCoords = duty.hospital?.coordinates?.coordinates;
                if (!hospitalCoords?.latitude || !hospitalCoords?.longitude) continue;

                const excludedIds = new Set([
                    ...(duty.autoRelist.excludedStaff || []).map(id => id.toString()),
                    ...(await blockService.staffHiddenFrom(duty.hospital._id || duty.hospital))
                ]);
                const matchingStaff = await locationBasedStaffService.getNearbyStaffByRole(
                    { latitude: hospitalCoords.latitude, longitude: hospitalCoords.longitude },
                    duty.staffRole,
                    100,
                    notificationRadiusKm,
                    { demo: !!duty.isDemo }
                );
                const pushStaff = matchingStaff
                    .filter(s => s.user && s.user._id && !excludedIds.has(s._id.toString()));
                const staffUserIds = pushStaff.map(s => s.user._id.toString());
                await dutyOfferService.onRelist(duty, pushStaff.map(s => s._id), notificationRadiusKm);

                if (staffUserIds.length > 0) {
                    await notificationEmitter.emitDutyRelistRepeatPush(duty, staffUserIds, {
                        boosted: !!duty.autoRelist.rateBoostApplied,
                        pushNumber: targetPushCount + 1
                    });
                }

                await Duty.updateOne({ _id: duty._id }, { $set: { 'autoRelist.repeatPushCount': targetPushCount } });
                sentCount++;
            } catch (err) {
                console.error(`Error sending auto-relist repeat push for duty ${duty._id}:`, err);
            }
        }

        return sentCount;
    },

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
                    await Duty.updateOne({ _id: duty._id }, { $set: { unfilledCriticalNotified: true, unfilledCriticalNotifiedAt: new Date() } });
                    notified++;
                }
            } catch (err) {
                console.error(`Error sending critical unfilled notification for duty ${duty._id}:`, err);
            }
        }

        return notified;
    },

    /**
     * Auto-escalate: flag unassigned duties starting within 1 hour for admin attention.
     * Does NOT mutate urgency — uses escalatedToCritical as the escalation flag.
     * Returns count and duty objects so the cron can notify admins.
     */
    async autoEscalateUnassignedDuties() {
        const istNow = getCurrentIST();
        const oneHourLater = new Date(istNow.getTime() + 60 * 60 * 1000);

        // Find available (unassigned) duties not yet flagged for escalation
        const candidates = await Duty.find({
            status: 'available',
            assignedTo: null,
            escalatedToCritical: { $ne: true }
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
            { $set: { escalatedToCritical: true, escalatedToCriticalAt: new Date() } }
        );

        return { count: toEscalate.length, duties: toEscalate };
    }
};
