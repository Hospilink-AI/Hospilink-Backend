// Admin: suspensions and manual overrides of duties, applications and codes
// Methods of AdminService; mixed into the class in ../admin.service.js, so `this` is the service.
const Duty = require('../../models/Duty');
const MedicalStaff = require('../../models/MedicalStaff');
const Hospital = require('../../models/Hospital');
const { getCurrentIST } = require('../../utils/helpers');
const EmailService = require('../email.service');
const CacheInvalidationService = require('../cacheInvalidation.service');
const cacheService = require('../cache.service');
const logger = require('../../utils/logger');
const notificationEmitter = require('../notificationEmitter');
const InterviewSchedulingService = require('../interviewScheduling.service');
const SystemConfigService = require('../systemConfig.service');
const JobApplication = require('../../models/JobApplication');
const { ACTIVE_STATUSES } = require('../../utils/jobApplication.constants');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
    UnprocessableEntityError
} = require('../../middleware/error.middleware');

module.exports = {
    // PATCH /api/admin/hospitals/:hospitalId/suspend
    async suspendHospital(hospitalId, reason) {
        if (!reason) throw new ValidationError('Suspension reason is required');

        const hospital = await Hospital.findById(hospitalId).populate('user', 'name email');
        if (!hospital) throw new NotFoundError('Hospital not found');

        if (hospital.isSuspended) {
            throw new ConflictError('Hospital account is already suspended');
        }

        hospital.isSuspended = true;
        hospital.suspensionReason = reason;
        hospital.suspendedAt = new Date();
        await hospital.save();

        const userId = hospital.user._id;

        // Invalidate all relevant caches immediately
        await Promise.allSettled([
            CacheInvalidationService.invalidateHospitalSuspensionCache(userId),
            CacheInvalidationService.invalidateHospitalVerificationCache(userId),
            cacheService.invalidateUserProfiles(userId.toString()),
            cacheService.invalidateProfileStatus(userId.toString()),
            cacheService.del(`session:${userId}`)
        ]);

        // Re-warm the suspension cache so the next request hits cache, not DB
        await CacheInvalidationService.refreshHospitalSuspensionCache(userId);

        logger.info(`Hospital ${hospitalId} suspended. Reason: ${reason}`);

        // Fire-and-forget: email + notification
        EmailService.sendAccountSuspendedEmail(hospital.user.email, hospital.hospitalLegalName, reason)
            .catch(err => logger.error('Suspension email error:', err.message));

        notificationEmitter.emitAccountSuspended(hospital, userId.toString(), 'hospital', reason)
            .catch(err => logger.error('Suspension notification error:', err.message));

        return {
            id: hospital._id,
            isSuspended: hospital.isSuspended,
            suspensionReason: hospital.suspensionReason,
            suspendedAt: hospital.suspendedAt,
            message: 'Hospital account suspended successfully'
        };
    },

    // PATCH /api/admin/hospitals/:hospitalId/unsuspend
    async unsuspendHospital(hospitalId) {
        const hospital = await Hospital.findById(hospitalId).populate('user', 'name email');
        if (!hospital) throw new NotFoundError('Hospital not found');

        if (!hospital.isSuspended) {
            throw new ConflictError('Hospital account is not currently suspended');
        }

        hospital.isSuspended = false;
        hospital.suspensionReason = null;
        hospital.suspendedAt = null;
        await hospital.save();

        const userId = hospital.user._id;

        await Promise.allSettled([
            CacheInvalidationService.invalidateHospitalSuspensionCache(userId),
            CacheInvalidationService.invalidateHospitalVerificationCache(userId),
            cacheService.invalidateUserProfiles(userId.toString()),
            cacheService.invalidateProfileStatus(userId.toString()),
            cacheService.del(`session:${userId}`)
        ]);

        await CacheInvalidationService.refreshHospitalSuspensionCache(userId);

        logger.info(`Hospital ${hospitalId} unsuspended`);

        EmailService.sendAccountActivatedEmail(hospital.user.email, hospital.hospitalLegalName)
            .catch(err => logger.error('Unsuspend email error:', err.message));

        notificationEmitter.emitAccountActivated(hospital, userId.toString(), 'hospital')
            .catch(err => logger.error('Unsuspend notification error:', err.message));

        return {
            id: hospital._id,
            isSuspended: hospital.isSuspended,
            suspensionReason: hospital.suspensionReason,
            message: 'Hospital account unsuspended successfully'
        };
    },

    // PATCH /api/admin/medical-staff/:staffId/suspend
    async suspendMedicalStaff(staffId, reason) {
        if (!reason) throw new ValidationError('Suspension reason is required');

        const staff = await MedicalStaff.findById(staffId).populate('user', 'name email');
        if (!staff) throw new NotFoundError('Medical staff not found');

        if (staff.isSuspended) {
            throw new ConflictError('Staff account is already suspended');
        }

        staff.isSuspended = true;
        staff.suspensionReason = reason;
        staff.suspendedAt = new Date();
        await staff.save();

        const userId = staff.user._id;

        await Promise.allSettled([
            CacheInvalidationService.invalidateStaffSuspensionCache(userId),
            CacheInvalidationService.invalidateStaffVerificationCache(userId),
            cacheService.invalidateUserProfiles(userId.toString()),
            cacheService.invalidateProfileStatus(userId.toString()),
            cacheService.del(`session:${userId}`),
            cacheService.del(`staff_availability:${userId}`)
        ]);

        await CacheInvalidationService.refreshStaffSuspensionCache(userId);

        logger.info(`Medical staff ${staffId} suspended. Reason: ${reason}`);

        EmailService.sendAccountSuspendedEmail(staff.user.email, staff.fullName, reason)
            .catch(err => logger.error('Suspension email error:', err.message));

        notificationEmitter.emitAccountSuspended(staff, userId.toString(), 'staff', reason)
            .catch(err => logger.error('Suspension notification error:', err.message));

        return {
            id: staff._id,
            isSuspended: staff.isSuspended,
            suspensionReason: staff.suspensionReason,
            suspendedAt: staff.suspendedAt,
            message: 'Staff account suspended successfully'
        };
    },

    // PATCH /api/admin/medical-staff/:staffId/unsuspend
    async unsuspendMedicalStaff(staffId) {
        const staff = await MedicalStaff.findById(staffId).populate('user', 'name email');
        if (!staff) throw new NotFoundError('Medical staff not found');

        if (!staff.isSuspended) {
            throw new ConflictError('Staff account is not currently suspended');
        }

        staff.isSuspended = false;
        staff.suspensionReason = null;
        staff.suspendedAt = null;
        await staff.save();

        const userId = staff.user._id;

        await Promise.allSettled([
            CacheInvalidationService.invalidateStaffSuspensionCache(userId),
            CacheInvalidationService.invalidateStaffVerificationCache(userId),
            cacheService.invalidateUserProfiles(userId.toString()),
            cacheService.invalidateProfileStatus(userId.toString()),
            cacheService.del(`session:${userId}`),
            cacheService.del(`staff_availability:${userId}`)
        ]);

        await CacheInvalidationService.refreshStaffSuspensionCache(userId);

        logger.info(`Medical staff ${staffId} unsuspended`);

        EmailService.sendAccountActivatedEmail(staff.user.email, staff.fullName)
            .catch(err => logger.error('Unsuspend email error:', err.message));

        notificationEmitter.emitAccountActivated(staff, userId.toString(), 'staff')
            .catch(err => logger.error('Unsuspend notification error:', err.message));

        return {
            id: staff._id,
            isSuspended: staff.isSuspended,
            suspensionReason: staff.suspensionReason,
            message: 'Staff account unsuspended successfully'
        };
    },

    // Admin overrides duty status
    async adminOverrideDutyStatus(dutyId, adminUserId, newStatus, reason) {
        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        const allowedTransitions = {
            'available': ['assigned', 'enroute', 'in-progress', 'completed'],
            'assigned': ['available', 'enroute', 'in-progress', 'completed'],
            'enroute': ['available', 'assigned', 'in-progress', 'completed'],
            'in-progress': ['completed'],
            'pending-confirmation': ['completed'],
            'completed': []
        };

        if (!allowedTransitions[duty.status]) {
            throw new ValidationError(`Admin override is not allowed from status ${duty.status}`);
        }

        if (!allowedTransitions[duty.status].includes(newStatus)) {
            throw new ValidationError(`Invalid override transition from ${duty.status} to ${newStatus}`);
        }

        const previousStatus = duty.status;
        duty.status = newStatus;
        duty.statusHistory.push({
            status: newStatus,
            timestamp: getCurrentIST(),
            changedBy: adminUserId,
            reason,
            manualOverride: true,
            overriddenFromStatus: previousStatus
        });
        if (newStatus === 'completed' && !duty.completedAt) {
            duty.completedAt = getCurrentIST();
        }

        await duty.save();

        await duty.populate({
            path: 'assignedTo',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        await duty.populate({
            path: 'hospital',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        return duty;
    },

    // Admin bypasses the normal hospital/candidate ownership check to force
    // a JobApplication status change — used by REVOKE_APPLICATION (target
    // 'withdrawn', never active) and REINSTATE_APPLICATION (target is
    // whatever status the ticketConsequence handler resolved as "prior",
    // which CAN be active). Deliberately doesn't own the "is this
    // transition legal" business rule — that differs between the two
    // callers — only the mechanics: load, guard the one real collision
    // case, patch, save.
    async adminOverrideApplicationStatus(applicationId, adminId, newStatus, reason, extraFields = {}) {
        const application = await JobApplication.findById(applicationId);
        if (!application) {
            throw new NotFoundError('Application not found');
        }

        if (ACTIVE_STATUSES.includes(newStatus)) {
            // Landing back in an ACTIVE status could collide with a fresh
            // active application the candidate has since filed for the same
            // vacancy — the partial unique index on {vacancy, staff} allows
            // only one. Caught here with a clear message; the try/catch
            // around save() below is a second line of defense against the
            // check-then-write race window.
            const collision = await JobApplication.findOne({
                vacancy: application.vacancy,
                staff: application.staff,
                _id: { $ne: application._id },
                status: { $in: ACTIVE_STATUSES }
            }).select('_id').lean();
            if (collision) {
                throw new UnprocessableEntityError(
                    'Cannot restore this application to an active status — the candidate already has a newer active application for this vacancy. Resolve or withdraw that one first.'
                );
            }
        }

        Object.assign(application, extraFields);
        application.status = newStatus;
        application.pushHistory(newStatus, adminId, reason);

        try {
            await application.save();
        } catch (err) {
            if (err.code === 11000) {
                throw new UnprocessableEntityError(
                    'Cannot restore this application — it now conflicts with another active application for the same vacancy.'
                );
            }
            throw err;
        }
        return application;
    },

    // Admin-triggered reschedule (RESCHEDULE_INTERVIEW dispute-resolution
    // action) — confirmed -> slots_offered, same mechanics as
    // interviewScheduling.service.js#rescheduleInterview, but not routed
    // through it: that method's _loadOwnedApplication assumes a hospital
    // requester (an admin isn't one), and it enforces interview.rescheduleCap,
    // which an admin dispute resolution deliberately bypasses — the
    // jobs.interview_reschedule dispute category exists largely because the
    // parties are already stuck at that cap. rescheduleCount/rescheduleHistory
    // are still updated so the count stays accurate for anyone looking later.
    async adminRescheduleInterview(applicationId, adminId, { slots, durationMinutes }, reason) {
        const application = await JobApplication.findById(applicationId);
        if (!application) {
            throw new NotFoundError('Application not found');
        }
        if (application.status !== 'confirmed') {
            throw new UnprocessableEntityError(
                `Admin reschedule is only allowed from status confirmed (currently ${application.status}).`
            );
        }

        const resolvedDuration = durationMinutes || await SystemConfigService.getEffective('interview.slotDurationDefault');
        await InterviewSchedulingService._validateSlotWindow(slots, resolvedDuration);
        const { normalizedSlots, offeredAt, expiresAt } = await InterviewSchedulingService._buildOfferWindow(slots);

        const previousSlot = application.interview.confirmedSlot?.start
            ? { start: application.interview.confirmedSlot.start, end: application.interview.confirmedSlot.end }
            : null;
        const isLateChange = await InterviewSchedulingService._computeIsLateChange(application.interview.confirmedSlot?.start);

        application.status = 'slots_offered';
        InterviewSchedulingService._releaseBooking(application);
        application.interview.offer = {
            slots: normalizedSlots,
            durationMinutes: resolvedDuration,
            offeredAt,
            offeredBy: adminId,
            expiresAt,
            cancelledAt: null,
            // cancelReason is an enum field — never assign it null explicitly
            // (Mongoose's enum validator rejects null); omit so it stays unset.
            cancelReasonText: null,
            nudgesSent: { day3: false, day10: false, day18: false }
        };
        application.interview.candidatePicks = undefined;
        application.interview.pickedAt = null;
        application.interview.rescheduleCount += 1;
        application.interview.rescheduleHistory.push({ by: 'admin', reason, previousSlot });
        application.pushHistory('slots_offered', adminId, reason, isLateChange);

        await application.save();
        await notificationEmitter.emitInterviewRescheduled(application);
        return application;
    },

    // Admin unlocks a locked start/end OTP
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
    },

    // Same rules as DutyService.setAutoRelistEnabled, without the hospital ownership check
    async setDutyAutoRelistEnabled(dutyId, enabled) {
        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (!['available', 'assigned'].includes(duty.status)) {
            throw new ValidationError('Auto-relist can only be changed while the duty is available or assigned');
        }

        duty.autoRelist = duty.autoRelist || {};
        duty.autoRelist.enabled = enabled;
        await duty.save();

        return duty;
    }
};
