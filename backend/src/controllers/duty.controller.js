const DutyService = require('../services/duty.service');
const EmailService = require('../services/email.service');
const { asyncHandler } = require('../middleware/error.middleware');
const { normalizeRole } = require('../utils/helpers');
const notificationEmitter = require('../services/notificationEmitter');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const User = require('../models/User');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const Duty = require('../models/Duty');
const logger = require('../utils/logger');
const dutyService = require('../services/duty.service');
const locationTrackingService = require('../services/locationTracking.service');
const DashboardService = require('../services/dashboard.service');
const locationBasedStaffService = require('../services/locationBasedStaff.service');
const notificationEmitterModule = require('../services/notificationEmitter');
const { ACTIVITY_ACTIONS: AA } = require('../utils/activityLog.constants');
const geocodingService = require('../services/geocoding.service');
const CancellationService = require('../services/cancellation.service');
const dutyCalendarService = require('../services/dutyCalendar.service');
const dutyOfferService = require('../services/dutyOffer.service');
const blockService = require('../services/block.service');
const dutyInviteService = require('../services/dutyInvite.service');
const systemConfigService = require('../services/systemConfig.service');                    

// Extend logger with debug method
logger.debug = (message) => {
    if (process.env.NODE_ENV === 'development') {
        console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`);
    }
};



exports.createDuty = asyncHandler(async (req, res) => {
    // Map frontend snake_case payload to backend camelCase model
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
    } = req.body;

    // Doctors invited by name are checked before anything is created
    const invitees = await dutyInviteService.resolveInvitees(invite_staff_ids, staff_role, { hospitalUserId: req.user.id });


    // Use hospital user ID from the authenticated user (JWT)
    const userId = req.user.id;

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
        ...(typeof auto_relist_enabled === 'boolean' && { autoRelist: { enabled: auto_relist_enabled } })
    };


    // Create multiple duties based on staff_count
    const createdDuties = [];
    for (let i = 0; i < numberOfDuties; i++) {
        const result = await DutyService.createDuty(dutyData, userId);
        createdDuties.push(result.duty);
    }
    dutyCalendarService.invalidateCounts(userId);

    // Emit WebSocket notification to matching available staff AND hospital
    try {
        // Get hospital details first for coordinates
        const hospital = await Hospital.findOne({ user: userId }).populate('user', 'name');
        
        if (!hospital) {
            logger.error('Hospital not found for user: ' + userId);
            throw new Error('Hospital profile not found');
        }

        // Check if hospital has coordinates
        if (!hospital.coordinates || !hospital.coordinates.coordinates) {
            logger.error('Hospital coordinates not found for user: ' + userId);
            throw new Error('Hospital location not set. Please update hospital profile.');
        }
        
        const hospitalCoords = {
            latitude: hospital.coordinates.coordinates.latitude,
            longitude: hospital.coordinates.coordinates.longitude
        };

        // Staged offer (first ring, or the whole city for emergencies); the
        // old 50 km search only when staged offers are switched off
        const offerStart = await dutyOfferService.startOffer(
            createdDuties,
            hospital,
            invitees.length ? { staff: invitees, openAfterInvite: open_after_invite !== false } : null
        );
        let staffUserIds = offerStart?.userIds;
        if (!staffUserIds) {
            const matchingStaff = await locationBasedStaffService.getNearbyStaffByRole(
                hospitalCoords,
                staff_role,
                100,
                50,
                { demo: !!hospital.isDemo }
            );

            // Convert to user IDs for notification, skipping blocked doctors
            const hidden = new Set(await blockService.staffHiddenFrom(hospital._id));
            staffUserIds = matchingStaff
                .filter(staff => staff.user && staff.user._id && !hidden.has(String(staff._id)))
                .map(staff => staff.user._id.toString());
        }

        console.log(`Notifying ${staffUserIds.length} staff for ${staff_role} role`);

        if (!hospital) {
            logger.error('Hospital not found for user: ' + userId);
            throw new Error('Hospital profile not found');
        }

        Duty.updateMany(
            { _id: { $in: createdDuties.map(d => d._id) } },
            { $set: { notifiedCount: staffUserIds.length } }
        ).catch(err => logger.error('Error saving notified count:', err));

        // Several slots posted together go out as one notification naming the count
        const batchThreshold = await systemConfigService.getEffective('calendar.batchNotificationThreshold');
        const isBatch = createdDuties.length >= batchThreshold;
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
        if (isBatch) {
            await notificationEmitter.emitDutyCreated(createdDuties[0], hospital, offerUserIds, userId, {
                count: createdDuties.length,
                dutyIds: createdDuties.map(d => d._id.toString())
            });
        }

        // Emit notification to both hospital and matching staff for all created duties
        for (const duty of createdDuties) {
            if (!isBatch) {
                await notificationEmitter.emitDutyCreated(duty, hospital, offerUserIds, userId);
            }
            
            // Log duty creation activity
            const isEmergency = duty.urgency === 'emergency';
            activityLogEmitter.logDutyCreated(duty, hospital, req, isEmergency)
                .catch(err => logger.error('Error logging duty creation:', err));

            // Notify all admins if this is an emergency duty
            if (isEmergency) {
                User.find({ role: 'admin' }).select('_id').then(async (admins) => {
                    if (!admins.length) return;
                    const adminIds = admins.map(a => a._id.toString());
                    await notificationEmitterModule.emitEmergencyAdminAlert(duty, hospital, adminIds, 'emergency_created');

                    // Email only to the configured alert address
                    const alertEmail = process.env.ADMIN_LOGIN_ALERT_EMAIL;
                    if (alertEmail) {
                        EmailService.sendEmergencyAdminAlertEmail(alertEmail, 'Admin', duty, hospital, 'emergency_created')
                            .catch(err => logger.error(`Error sending emergency alert email: ${err.message}`));
                    }

                    activityLogEmitter.emitSystemActivity(
                        AA.EMERGENCY_DUTY_ADMIN_NOTIFIED,
                        { dutyId: duty._id?.toString(), reason: 'emergency_created', adminCount: admins.length }
                    ).catch(err => logger.error('Error logging emergency admin notification:', err));
                }).catch(err => logger.error('Error fetching admins for emergency notification:', err));
            }
        }
    } catch (error) {
        logger.error('Error emitting duty created notification: ' + error.message);
        // Don't fail the request if notification fails
    }

    res.status(201).json({
        success: true,
        duties: createdDuties,
        count: createdDuties.length,
        message: `Successfully created ${createdDuties.length} ${createdDuties.length === 1 ? 'duty' : 'duties'}`
    });
});



exports.getActiveDuties = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { date, startDate, endDate, status, staffRole, page = 1, limit = 10 } = req.query;

    const result = await DutyService.getActiveDuties({
        hospitalUserId: userId,
        date,
        startDate,
        endDate,
        status,
        staffRole,
        page: parseInt(page),
        limit: parseInt(limit)
    });

    res.status(200).json({
        success: true,
        count: result.duties.length,
        data: result.duties,
        pagination: result.pagination
    });
});




exports.getDutyHistory = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { date, startDate, endDate, status, staffRole, page = 1, limit = 10 } = req.query;
 
    const result = await DutyService.getDutyHistory({
        hospitalUserId: userId,
        date,
        startDate,
        endDate,
        status,
        staffRole,
        page: parseInt(page),
        limit: parseInt(limit)
    });
 
    res.status(200).json({
        success: true,
        count: result.duties.length,
        data: result.duties,
        pagination: result.pagination
    });
});



exports.getMyUpcomingDuties = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // Get duties that this staff member has accepted
    const duties = await DutyService.getUpcomingDutiesForStaff(userId);
    res.status(200).json({
        success: true,
        count: duties.length,
        data: duties
    });
});



exports.acceptDuty = asyncHandler(async (req, res) => {
    const { duty_id } = req.body;
    const userId = req.user.id; // Using authenticated user ID from JWT

    try {
        const duty = await DutyService.acceptDuty(duty_id, userId);
        dutyCalendarService.invalidateCounts(userId);

        // Prepare email details
        const dutyDetails = {
            hospitalName: duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'HospiLink Partner',
            staffRole: duty.staffRole,
            date: new Date(duty.date).toLocaleDateString(),
            time: `${duty.startTime} - ${duty.endTime}`,
            rate: duty.offeredRate
        };

        // Send email to STAFF (Self)
        EmailService.sendDutyAcceptanceEmail(
            req.user.email,
            req.user.name,
            dutyDetails
        ).catch(err => logger.error('Failed to send staff acceptance email: ' + err.message));

        // Send email to HOSPITAL
        if (duty.hospital && duty.hospital.user && duty.hospital.user.email) {
            EmailService.sendHospitalDutyNotificationEmail(
                duty.hospital.user.email,
                duty.hospital.user.name,
                { name: req.user.name, email: req.user.email },
                dutyDetails
            ).catch(err => logger.error('Failed to send hospital notification email: ' + err.message));
        }

        // Emit WebSocket notification to hospital and staff
        try {
            const hospitalUserId = duty.hospital.user._id.toString();
            const staff = await MedicalStaff.findOne({ user: userId }).populate('user', 'name');

            await notificationEmitter.emitDutyAccepted(duty, staff, hospitalUserId, userId);
            
            // Log duty acceptance activity
            activityLogEmitter.logDutyAccepted(duty, staff, req)
                .catch(err => logger.error('Error logging duty acceptance:', err));
        } catch (error) {
            logger.error('Error emitting duty accepted notification: ' + error.message);
            // Don't fail the request if notification fails
        }

        res.status(200).json({
            success: true,
            message: 'Duty accepted successfully. Confirmation email sent.',
            duty
        });
    } catch (error) {
        if (error.message.includes('Role mismatch')) {
            return res.status(403).json({
                success: false,
                message: error.message,
                code: 'ROLE_MISMATCH'
            });
        }

        // Handle other specific errors
        if (error.message.includes('already being processed')) {
            return res.status(409).json({
                success: false,
                message: error.message,
                code: 'DUPLICATE_REQUEST'
            });
        }

        if (error.message.includes('Duty is no longer available')) {
            return res.status(409).json({
                success: false,
                message: error.message,
                code: 'DUTY_UNAVAILABLE'
            });
        }

        if (error.message.includes('Medical staff profile not found')) {
            return res.status(404).json({
                success: false,
                message: error.message,
                code: 'PROFILE_NOT_FOUND'
            });
        }

        if (error.message.includes('Time conflict')) {
            return res.status(409).json({
                success: false,
                message: error.message,
                code: 'TIME_CONFLICT'
            });
        }

        if (error.message.includes('Cannot accept duty after start time')) {
            return res.status(422).json({
                success: false,
                message: error.message,
                code: 'ACCEPT_AFTER_START'
            });
        }

        // Re-throw other errors to be handled by global error handler
        throw error;
    }
});




exports.changeDutyStatus = asyncHandler(async (req, res) => {
    const { status, duty_id } = req.body;
    const userId = req.user.id;

    // Validate status value
    const allowedStatuses = ['enroute'];
    logger.debug('Validating status change request');

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid status. Allowed values: enroute'
        });
    }

    // Store previous status before update
    const dutyBeforeUpdate = await Duty.findById(duty_id);
    const previousStatus = dutyBeforeUpdate ? dutyBeforeUpdate.status : null;

    const duty = await DutyService.changeDutyStatus(duty_id, userId, status);

    // Prepare email details
    const dutyDetails = {
        hospitalName: duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'HospiLink Partner',
        staffRole: duty.staffRole,
        date: new Date(duty.date).toLocaleDateString(),
        time: `${duty.startTime} - ${duty.endTime}`,
        rate: duty.offeredRate
    };

    // Send email to STAFF (Self)
    EmailService.sendDutyStatusUpdateEmail(
        req.user.email,
        req.user.name,
        dutyDetails,
        status
    ).catch(err => logger.error('Failed to send staff status update email: ' + err.message));

    // Send email to HOSPITAL
    if (duty.hospital && duty.hospital.user && duty.hospital.user.email) {
        EmailService.sendHospitalStatusUpdateEmail(
            duty.hospital.user.email,
            duty.hospital.user.name,
            { name: req.user.name, email: req.user.email },
            dutyDetails,
            status
        ).catch(err => logger.error('Failed to send hospital status update email: ' + err.message));
    }

    // Emit WebSocket notification to hospital (staff is en route)
    try {
        const hospitalUserId = duty.hospital.user._id.toString();

        const staff = await MedicalStaff.findOne({ user: userId }).populate('user', 'name');

        if (staff) {
            // Try to calculate ETA if coordinates are available
            let eta = null;
            try {
                const hospital = await Hospital.findById(duty.hospital._id || duty.hospital);

                const staffLat = staff.coordinates?.coordinates?.latitude;
                const staffLng = staff.coordinates?.coordinates?.longitude;
                const hospitalLat = hospital?.coordinates?.coordinates?.latitude;
                const hospitalLng = hospital?.coordinates?.coordinates?.longitude;

                if (staffLat && staffLng && hospitalLat && hospitalLng) {
                    const distanceInfo = await geocodingService.calculateDistanceAndETA(
                        staffLat,
                        staffLng,
                        hospitalLat,
                        hospitalLng
                    );
                    eta = distanceInfo.duration; // in minutes
                }
            } catch (etaError) {
                console.error('Error calculating ETA for en route notification:', etaError);
            }

            await notificationEmitter.emitStaffEnRoute(duty, staff, hospitalUserId, eta);

            // Log duty started activity
            activityLogEmitter.logDutyStatusChange(duty, staff, status, req)
                .catch(err => logger.error('Error logging duty start:', err));
        }
    } catch (error) {
        logger.error('Error emitting duty status notification: ' + error.message);
        // Don't fail the request if notification fails
    }

    res.status(200).json({
        success: true,
        message: `Duty status changed to ${status} successfully. Notification email sent.`,
        duty
    });
});





exports.requestStartOtp = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const { latitude, longitude } = req.body || {};
    const sentLocation = typeof latitude === 'number' ? { latitude, longitude } : null;

    const { alreadyInProgress, expiresAt } = await DutyService.requestStartOtp(id, userId, sentLocation);

    res.status(200).json({
        success: true,
        message: alreadyInProgress
            ? 'Duty is already in progress.'
            : 'Start OTP sent to the hospital via SMS. Ask the hospital to share the code with you.',
        data: { expiresAt }
    });
});




exports.verifyStartOtp = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { otp, latitude, longitude } = req.body;
    const userId = req.user.id;
    const sentLocation = typeof latitude === 'number' ? { latitude, longitude } : null;

    const duty = await DutyService.verifyStartOtp(id, userId, otp, sentLocation);

    // Emit on-site notification to hospital + in-progress notification to staff
    try {
        const hospitalUserId = duty.hospital.user._id.toString();
        const staffUserId = userId;

        const staff = await MedicalStaff.findOne({ user: userId }).populate('user', 'name');
        if (staff) {
            await notificationEmitter.emitStaffOnSite(duty, staff, hospitalUserId);

            const hospital = await Hospital.findById(duty.hospital._id || duty.hospital);
            if (hospital) {
                await notificationEmitter.emitDutyInProgress(duty, hospital, staffUserId);
            }

            activityLogEmitter.logDutyStatusChange(duty, staff, 'in-progress', req)
                .catch(err => logger.error('Error logging duty in-progress:', err));
        }
    } catch (error) {
        logger.error('Error emitting duty in-progress notification: ' + error.message);
        // Don't fail the request if notification fails
    }

    res.status(200).json({
        success: true,
        message: 'Start OTP verified. Duty is now in progress.',
        duty
    });
});




exports.requestEndOtp = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const { expiresAt } = await DutyService.requestEndOtp(id, userId);

    res.status(200).json({
        success: true,
        message: 'End OTP sent to your registered mobile number via SMS. Share this code with the hospital to mark the duty complete.',
        data: { expiresAt }
    });
});




exports.verifyEndOtp = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { otp, paymentMethod, isPaid } = req.body;
    const userId = req.user.id;

    const duty = await DutyService.verifyEndOtp(id, userId, otp, paymentMethod, isPaid);

    // Emit completion notifications: rate-your-doctor prompt to hospital,
    // rate-this-hospital prompt to staff
    try {
        const hospitalUserId = duty.hospital.user._id.toString();
        const staff = await MedicalStaff.findOne({ _id: duty.assignedTo }).populate('user', 'name');

        if (staff) {
            await notificationEmitter.emitDutyCompleted(duty, staff, hospitalUserId);

            activityLogEmitter.logDutyStatusChange(duty, staff, 'completed', req)
                .catch(err => logger.error('Error logging duty completion:', err));
        }

        const staffUserId = duty.assignedTo?.user?._id?.toString();
        if (staffUserId) {
            await notificationEmitter.emitRateHospitalPrompt(duty, duty.hospital, staffUserId);
        }
    } catch (error) {
        logger.error('Error emitting duty completed notification: ' + error.message);
        // Don't fail the request if notification fails
    }

    res.status(200).json({
        success: true,
        message: 'End OTP verified. Duty marked as completed.',
        duty
    });
});




exports.resendOtp = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { otpType } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    const result = await DutyService.resendOtp(id, userId, userRole, otpType);

    if (otpType === 'start' && result.alreadyInProgress) {
        return res.status(200).json({
            success: true,
            message: 'Duty is already in progress.',
            data: { expiresAt: null }
        });
    }

    res.status(200).json({
        success: true,
        message: otpType === 'start'
            ? 'A new start OTP has been sent to the hospital via SMS. Ask the hospital to share the code with you.'
            : 'A new end OTP has been sent to the staff member\'s registered mobile number via SMS.',
        data: { expiresAt: result.expiresAt }
    });
});





exports.getDutyStatusHistory = asyncHandler(async (req, res) => {
    const { dutyId } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    const result = await DutyService.getDutyStatusHistory(dutyId, userId, userRole);

    res.status(200).json({
        success: true,
        data: result
    });
});



exports.getOngoingDuties = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const duties = await DutyService.getOngoingDutiesForStaff(userId);

    res.status(200).json({
        success: true,
        count: duties.length,
        data: duties
    });
});



exports.editDuty = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    // Get the duty before update to track changes
    const dutyBeforeUpdate = await Duty.findById(id).populate('assignedTo');

    // Map frontend snake_case to backend camelCase
    const updateData = {};
    if (req.body.staff_role) updateData.staffRole = req.body.staff_role;
    if (req.body.date) updateData.date = req.body.date;
    if (req.body.end_date) updateData.endDate = req.body.end_date;
    if (req.body.start_time) updateData.startTime = req.body.start_time;
    if (req.body.end_time) updateData.endTime = req.body.end_time;
    if (req.body.urgency) updateData.urgency = req.body.urgency;
    if (req.body.description !== undefined) updateData.description = req.body.description;
    if (req.body.offered_rate !== undefined) updateData.offeredRate = req.body.offered_rate;
    if (req.body.is_overnight_duty !== undefined) updateData.isOvernightDuty = req.body.is_overnight_duty;
    if (req.body.duty_sub_type) updateData.dutySubType = req.body.duty_sub_type;

    const duty = await DutyService.editDuty(id, userId, updateData);
    dutyCalendarService.invalidateCounts(userId);

    // Emit WebSocket notification if duty is assigned
    try {
        if (dutyBeforeUpdate && dutyBeforeUpdate.assignedTo) {
            // Calculate changes
            const changes = [];
            const fieldMapping = {
                staffRole: 'Staff Role',
                date: 'Date',
                endDate: 'End Date',
                startTime: 'Start Time',
                endTime: 'End Time',
                urgency: 'Urgency',
                description: 'Description',
                offeredRate: 'Offered Rate',
                isOvernightDuty: 'Overnight Duty',
                dutySubType: 'Sub-type'
            };

            for (const [field, label] of Object.entries(fieldMapping)) {
                if (updateData[field] !== undefined && dutyBeforeUpdate[field] !== updateData[field]) {
                    changes.push({
                        field: label,
                        oldValue: dutyBeforeUpdate[field],
                        newValue: updateData[field]
                    });
                }
            }

            if (changes.length > 0) {
                const staffUserId = dutyBeforeUpdate.assignedTo.user.toString();
                await notificationEmitter.emitDutyEdited(duty, changes, staffUserId);
                
                // Log duty edit activity
                const hospital = await Hospital.findOne({ user: userId });
                if (hospital) {
                    const actor = {
                        userId: userId,
                        name: hospital.hospitalLegalName || hospital.name,
                        role: 'hospital',
                        email: hospital.user?.email
                    };
                    
                    activityLogEmitter.emitDutyActivity(
                        ACTIVITY_ACTIONS.DUTY_EDITED,
                        duty,
                        actor,
                        { changes },
                        req
                    ).catch(err => logger.error('Error logging duty edit:', err));
                }
            }
        }
    } catch (error) {
        logger.error('Error emitting duty edited notification: ' + error.message);
        // Don't fail the request if notification fails
    }

    res.status(200).json({
        success: true,
        message: 'Duty updated successfully',
        duty
    });
});



exports.setAutoRelistEnabled = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const { enabled } = req.body;

    const duty = await DutyService.setAutoRelistEnabled(id, userId, enabled);
    activityLogEmitter.emitDutyActivity(ACTIVITY_ACTIONS.DUTY_EDITED, duty, activityLogEmitter.actorFrom(req.user), { changes: [{ field: 'Auto-relist', newValue: enabled }] }, req)
        .catch(err => logger.error('Error logging auto-relist change:', err));

    res.status(200).json({
        success: true,
        message: `Auto-relist ${enabled ? 'enabled' : 'disabled'} for this duty`,
        data: {
            dutyId: duty._id,
            autoRelist: {
                enabled: duty.autoRelist.enabled,
                relistCount: duty.autoRelist.relistCount,
                rateBoostApplied: duty.autoRelist.rateBoostApplied
            }
        }
    });
});



exports.getFindingCoverPanel = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const duties = await DutyService.getFindingCoverPanel(userId);

    res.status(200).json({
        success: true,
        duties
    });
});



exports.getAutoRelistMonthToDate = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const summary = await DutyService.getAutoRelistMonthToDate(userId);

    res.status(200).json({
        success: true,
        ...summary
    });
});



exports.getDutyDetail = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const duty = await DutyService.getDutyDetail(id, userId, userRole);

    res.status(200).json({
        success: true,
        duty
    });
});



exports.cancelDuty = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason, reasonText } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Validate required fields
    if (!reason) {
        return res.status(400).json({
            success: false,
            message: 'Cancellation reason is required'
        });
    }


    try {
        // Cancel the duty
        const duty = await CancellationService.cancelDuty(
            id,
            { _id: userId, role: userRole },
            reason,
            reasonText
        );

        // Get the previous status from statusHistory (before cancellation)
        const previousStatus = duty.statusHistory.length >= 2
            ? duty.statusHistory[duty.statusHistory.length - 2].status
            : 'available';

        logger.debug(`Duty cancellation: statusHistory entries=${duty.statusHistory.length}, previousStatus=${previousStatus}, currentStatus=${duty.status}`);

        // Determine notification recipients based on previous status
        let shouldNotifyStaff = false;
        let shouldNotifyHospital = false;

        if (previousStatus === 'available') {
            // Duty was never assigned - only notify hospital
            shouldNotifyHospital = true;
            shouldNotifyStaff = false;
            logger.debug('Duty was never assigned - notifying hospital only');
        } else if (['assigned', 'enroute', 'in-progress'].includes(previousStatus)) {
            // Duty was assigned - notify both parties
            shouldNotifyHospital = true;
            shouldNotifyStaff = true;
            logger.debug('Duty was assigned - notifying both parties');
        }

        if (shouldNotifyHospital || shouldNotifyStaff) {
            logger.debug('Preparing to send notifications');
            // Prepare duty details for email
            const dutyDetails = {
                hospitalName: duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'HospiLink Partner',
                staffRole: duty.staffRole,
                date: new Date(duty.date).toLocaleDateString(),
                time: `${duty.startTime} - ${duty.endTime}`
            };

            const cancellationDetails = {
                cancelledBy: duty.cancellation.cancelledBy,
                reason: duty.cancellation.reason,
                reasonText: duty.cancellation.reasonText
            };

            // Send email to staff ONLY if duty was assigned
            if (shouldNotifyStaff && duty.assignedTo && duty.assignedTo.user && duty.assignedTo.user.email) {
                logger.debug('Sending cancellation email to staff');
                EmailService.sendStaffDutyCancellationEmail(
                    duty.assignedTo.user.email,
                    duty.assignedTo.user.name,
                    dutyDetails,
                    cancellationDetails
                ).catch(err => logger.error('Failed to send staff cancellation email: ' + err.message));
            }

            // Send email to hospital (always for cancellations)
            if (shouldNotifyHospital && duty.hospital && duty.hospital.user && duty.hospital.user.email) {
                logger.debug('Sending cancellation email to hospital');
                const staffDetails = (shouldNotifyStaff && duty.assignedTo) ? {
                    name: duty.assignedTo.user?.name || 'Staff Member',
                    email: duty.assignedTo.user?.email || ''
                } : null;

                EmailService.sendHospitalDutyCancellationEmail(
                    duty.hospital.user.email,
                    duty.hospital.user.name,
                    staffDetails,
                    dutyDetails,
                    cancellationDetails
                ).catch(err => logger.error('Failed to send hospital cancellation email: ' + err.message));
            }

            // Emit WebSocket notification
            try {
                const recipientUserIds = [];

                // Add hospital user ID (always)
                if (shouldNotifyHospital && duty.hospital && duty.hospital.user) {
                    recipientUserIds.push(duty.hospital.user._id.toString());
                    logger.debug('Added hospital to WebSocket recipients');
                }

                // Add staff user ID ONLY if duty was assigned
                if (shouldNotifyStaff && duty.assignedTo && duty.assignedTo.user) {
                    recipientUserIds.push(duty.assignedTo.user._id.toString());
                    logger.debug('Added staff to WebSocket recipients');
                }

                logger.debug(`Total WebSocket recipients: ${recipientUserIds.length}`);

                if (recipientUserIds.length > 0) {
                    await notificationEmitter.emitDutyCancelled(
                        duty,
                        req.user,
                        reason,
                        reasonText,
                        recipientUserIds
                    );
                    logger.debug('WebSocket notifications sent successfully');
                    
                    // Log duty cancellation activity
                    try {
                        // Get user name from duty.hospital or duty.assignedTo
                        let userName = req.user.name;
                        if (!userName) {
                            if (req.user.role === 'hospital' && duty.hospital) {
                                userName = duty.hospital.hospitalLegalName || duty.hospital.user?.name || 'Hospital';
                            } else if (req.user.role === 'staff' && duty.assignedTo) {
                                userName = duty.assignedTo.fullName || duty.assignedTo.user?.name || 'Staff';
                            } else {
                                userName = 'User';
                            }
                        }
                        
                        const actor = {
                            userId: req.user.id,
                            name: userName,
                            role: req.user.role,
                            email: req.user.email || 'unknown'
                        };
                        
                        activityLogEmitter.emitDutyActivity(
                            ACTIVITY_ACTIONS.DUTY_CANCELLED,
                            duty,
                            actor,
                            { reason, reasonText, cancelledBy: req.user.role },
                            req
                        ).catch(err => logger.error('Error logging duty cancellation:', err));
                    } catch (logError) {
                        logger.error('Error preparing duty cancellation log:', logError);
                    }
                } else {
                    logger.debug('No WebSocket recipients found');
                }
            } catch (error) {
                logger.error('Error emitting duty cancelled notification: ' + error.message);
                // Don't fail the request if notification fails
            }
        } else {
            logger.debug(`No notifications sent - invalid previous status: ${previousStatus}`);
        }

        res.status(200).json({
            success: true,
            message: 'Duty cancelled successfully',
            data: { duty }
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message
        });
    }
});



// Get detailed route information for a specific duty
exports.getDutyRoute = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const staffId = req.user.id;

    try {
        let currentLocation;
        let permissionGranted = false;
        let locationSource = 'unknown';

        // Use location from request body if provided
        if (req.body.currentLocation && 
            req.body.currentLocation.latitude && 
            req.body.currentLocation.longitude) {
            currentLocation = req.body.currentLocation;
            permissionGranted = req.body.locationPermission === 'granted';
            locationSource = 'request_body'; // Location from client request
        } else {
            // Fallback to dashboard service
            const locationInfo = await DashboardService.getStaffLocationForDuties(staffId);
            currentLocation = locationInfo.location;
            permissionGranted = locationInfo.permissionGranted;
            locationSource = locationInfo.source; // 'browser' or 'profile' from dashboard service
        }
        
        if (!permissionGranted) {
            return res.status(400).json({
                success: false,
                message: 'Location permission is required to view directions. Please enable location in your dashboard.',
                code: 'LOCATION_PERMISSION_REQUIRED'
            });
        }

        const result = await DutyService.getJobRouteInfo(id, staffId, currentLocation);

        // Initialize tracking session
        await locationTrackingService.storeInitialLocation(
            staffId,
            id,
            result.hospital.id,
            currentLocation
        );

        res.status(200).json({
            success: true,
            job: result.job,
            hospital: result.hospital,
            staffLocation: {
                ...currentLocation,
                source: locationSource
            },
            route: result.route,
            tracking: {
                sessionId: `tracking_${staffId}_${Date.now()}`,
                websocketRoom: `tracking:${staffId}:${id}`,
                hospitalTrackingRoom: `hospital_tracking:${result.hospital.id}`,
                updateInterval: 2000,
                arrivalThreshold: 100 // meters
            }
        });
    } catch (error) {
        logger.error('Error getting duty route:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message
        });
    }
});



// Get available jobs with distance for staff member
exports.getAvailableJobsWithDistance = asyncHandler(async (req, res) => {
    const staffId = req.user.id;
    const filters = req.query;
    
    const result = await locationBasedStaffService.getAvailableJobsWithDistance(staffId, filters);
    
    res.status(200).json({
        success: true,
        jobs: result.jobs,
        staffLocation: result.staffLocation,
        totalJobs: result.jobs.length
    });
});



// GET /api/duties/calendar-counts - per-date counts for the calendar grid
exports.getCalendarCounts = asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    const result = await dutyCalendarService.getCounts(req.user, from, to);

    res.status(200).json({
        success: true,
        ...result
    });
});



// GET /api/duties/:id/fill-progress - fill tracker for a hospital's duty
exports.getFillProgress = asyncHandler(async (req, res) => {
    const result = await dutyCalendarService.getFillProgress(req.user.id, req.params.id);

    res.status(200).json({
        success: true,
        ...result
    });
});



// GET /api/duties/calendar-day - duties behind one calendar date
exports.getCalendarDay = asyncHandler(async (req, res) => {
    const result = await dutyCalendarService.getDay(req.user, req.query.date);

    res.status(200).json({
        success: true,
        ...result
    });
});




exports.getCompletedDuties = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const { status } = req.query;

    const ALLOWED_STATUSES = ['completed', 'cancelled', 'incomplete'];
    if (status && !ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({
            success: false,
            message: `Invalid status filter. Allowed values: ${ALLOWED_STATUSES.join(', ')}`
        });
    }

    const result = await DutyService.getCompletedDutiesForStaff(userId, page, limit, status || null);

    res.status(200).json({
        success: true,
        summary: {
            totalDutiesCompleted: result.summary.totalDutiesCompleted,
            totalHours: result.summary.totalHours,
            totalEarnings: result.summary.totalEarnings,
            lastDutyDate: result.summary.lastDutyDate
        },
        duties: result.duties,
        pagination: result.pagination
    });
});



exports.getStatement = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const { dutyId, startDate, endDate } = req.query;

    await DutyService.generateStatement(userId, {
        dutyId,
        startDate,
        endDate
    }, res);
});




// GET /api/duties/active-duties - Get active duties for hospital
exports.getHospitalActiveDuties = asyncHandler(async (req, res) => {
    // Use validated query parameters from middleware
    const { role, status, page, limit } = req.validatedQuery;

    try {
        const hospital = await Hospital.findOne({ user: req.user.id });
        if (!hospital) {
            return res.status(404).json({
                success: false,
                message: 'Hospital profile not found'
            });
        }
        
        const result = await DutyService.getHospitalActiveDuties(
            hospital._id, 
            {
                role,
                status,
                page,
                limit
            }
        );

        res.status(200).json({
            success: true,
            data: result.duties,
            pagination: result.pagination,
            filters: result.filters,
            summary: result.summary
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message
        });
    }
});



// GET /api/duties/duty-route-map/:dutyId - Get duty route map for hospital
exports.getHospitalDutyRouteMap = asyncHandler(async (req, res) => {
    const { dutyId } = req.validatedParams;
    const hospital = await Hospital.findOne({ user: req.user.id });
    if (!hospital) {
        return res.status(404).json({
            success: false,
            message: 'Hospital profile not found'
        });
    }
    
    try {
        // Add request tracking for analytics
        const startTime = Date.now();
        
        const routeMap = await DutyService.getHospitalDutyRouteMap(dutyId, hospital._id);
        
        // Log performance metrics
        const responseTime = Date.now() - startTime;
        console.log(`Hospital duty route map generated in ${responseTime}ms for duty: ${dutyId}`);
        
        // Enhanced response with metadata
        res.status(200).json({
            success: true,
            data: routeMap,
            meta: {
                responseTime: `${responseTime}ms`,
                timestamp: new Date(),
                apiVersion: 'v2.0'
            }
        });
    } catch (error) {
        console.error(`Error in getHospitalDutyRouteMap for duty ${dutyId}:`, error);
        
        // Enhanced error response
        res.status(error.statusCode || (error.message.toLowerCase().includes('not found') ? 404 : 500)).json({
            success: false,
            message: error.message,
            code: error.code || 'DUTY_ROUTE_MAP_ERROR',
            meta: {
                dutyId,
                timestamp: new Date()
            }
        });
    }
});

