const DutyService = require('../services/duty.service');
const EmailService = require('../services/email.service');
const { asyncHandler } = require('../middleware/error.middleware');
const { normalizeRole } = require('../utils/helpers');
const notificationEmitter = require('../services/notificationEmitter');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const logger = require('../utils/logger');
const dutyService = require('../services/duty.service');
const locationTrackingService = require('../services/locationTracking.service');
const DashboardService = require('../services/dashboard.service');

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
        is_overnight_duty
    } = req.body;

    // Use hospital user ID from the authenticated user (JWT)
    const userId = req.user.id;

    const dutyData = {
        staffRole: staff_role,
        date,
        endDate: end_date,
        startTime: start_time,
        endTime: end_time,
        urgency,
        description,
        offeredRate: offered_rate,
        isOvernightDuty: is_overnight_duty || false
    };

    const result = await DutyService.createDuty(dutyData, userId);

    // Emit WebSocket notification to matching available staff AND hospital
    try {
        // Find matching available staff
        const normalizedRole = normalizeRole(staff_role);
        const matchingStaff = await MedicalStaff.find({
            jobRole: staff_role,
            isAvailable: true
        }).populate('user', '_id');

        // Filter out staff with null user references and map to user IDs
        const staffUserIds = matchingStaff
            .filter(staff => staff.user && staff.user._id)
            .map(staff => staff.user._id.toString());

        // Get hospital details
        const hospital = await Hospital.findOne({ user: userId }).populate('user', 'name');

        if (!hospital) {
            logger.error('Hospital not found for user: ' + userId);
            throw new Error('Hospital profile not found');
        }

        // Emit notification to both hospital and matching staff
        await notificationEmitter.emitDutyCreated(result.duty, hospital, staffUserIds, userId);
        
        // Log duty creation activity
        const isEmergency = result.duty.urgency === 'emergency';
        activityLogEmitter.logDutyCreated(result.duty, hospital, req, isEmergency)
            .catch(err => logger.error('Error logging duty creation:', err));

        // Notify all admins if this is an emergency duty
        if (isEmergency) {
            const User = require('../models/User');
            const notificationEmitterModule = require('../services/notificationEmitter');
            const EmailService = require('../services/email.service');
            const { ACTIVITY_ACTIONS: AA } = require('../utils/activityLog.constants');

            User.find({ role: 'admin' }).select('_id').then(async (admins) => {
                if (!admins.length) return;
                const adminIds = admins.map(a => a._id.toString());
                await notificationEmitterModule.emitEmergencyAdminAlert(result.duty, hospital, adminIds, 'emergency_created');

                // Email only to the configured alert address
                const alertEmail = process.env.ADMIN_LOGIN_ALERT_EMAIL;
                if (alertEmail) {
                    EmailService.sendEmergencyAdminAlertEmail(alertEmail, 'Admin', result.duty, hospital, 'emergency_created')
                        .catch(err => logger.error(`Error sending emergency alert email: ${err.message}`));
                }

                activityLogEmitter.emitSystemActivity(
                    AA.EMERGENCY_DUTY_ADMIN_NOTIFIED,
                    { dutyId: result.duty._id?.toString(), reason: 'emergency_created', adminCount: admins.length }
                ).catch(err => logger.error('Error logging emergency admin notification:', err));
            }).catch(err => logger.error('Error fetching admins for emergency notification:', err));
        }
    } catch (error) {
        logger.error('Error emitting duty created notification: ' + error.message);
        // Don't fail the request if notification fails
    }

    res.status(201).json({
        success: true,
        duty: result.duty
    });
});



exports.getDuties = asyncHandler(async (req, res) => {
    let query = {
        hospital: req.user.id // Only show duties for this hospital
    };

    if (req.query.status) {
        query.status = req.query.status;
    }

    if (req.query.staffRole) {
        query.staffRole = req.query.staffRole;
    }

    if (req.query.date) {
        const startDate = new Date(req.query.date);
        const endDate = new Date(req.query.date);
        endDate.setDate(endDate.getDate() + 1);

        query.date = {
            $gte: startDate,
            $lt: endDate
        };
    }

    if (req.query.urgency) {
        query.urgency = req.query.urgency;
    }

    const duties = await DutyService.getDuties(query);

    // Format duties with staff names for hospital view
    const formattedDuties = duties.map(duty => {
        const dutyObj = duty.toObject();

        if (duty.assignedTo && duty.assignedTo.user) {
            // Keep only essential staff information
            dutyObj.assignedTo = {
                _id: duty.assignedTo._id,
                user: {
                    _id: duty.assignedTo.user._id,
                    name: duty.assignedTo.user.name
                }
            };
            dutyObj.staffName = duty.assignedTo.user.name;
        } else {
            dutyObj.assignedTo = null;
            dutyObj.staffName = '_____';
        }

        return dutyObj;
    });

    // Response for hospital users
    res.status(200).json({
        success: true,
        count: duties.length,
        data: formattedDuties,
        filters: {
            status: query.status,
            staffRole: query.staffRole,
            date: req.query.date,
            urgency: query.urgency
        },
        message: duties.length > 0
            ? `Found ${duties.length} duties for your hospital`
            : 'No duties found for your hospital. Create your first duty now.'
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
        if (error.message.includes('Duty is no longer available')) {
            return res.status(400).json({
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

        // Re-throw other errors to be handled by global error handler
        throw error;
    }
});




exports.changeDutyStatus = asyncHandler(async (req, res) => {
    const { status, duty_id } = req.body;
    const userId = req.user.id;

    // Validate status value
    const allowedStatuses = ['enroute', 'in-progress', 'completed'];
    logger.debug('Validating status change request');

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid status. Allowed values: enroute, in-progress, completed'
        });
    }

    // Store previous status before update
    const dutyBeforeUpdate = await require('../models/Duty').findById(duty_id);
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

    // Emit WebSocket notification to both parties
    try {
        const hospitalUserId = duty.hospital.user._id.toString();
        const staffUserId = userId;

        // If duty is completed, send completion notification to hospital
        if (status === 'completed') {
            const MedicalStaff = require('../models/MedicalStaff');
            const staff = await MedicalStaff.findOne({ user: userId }).populate('user', 'name');
            
            if (staff) {
                await notificationEmitter.emitDutyCompleted(duty, staff, hospitalUserId);
                
                // Log duty completion activity
                activityLogEmitter.logDutyStatusChange(duty, staff, status, req)
                    .catch(err => logger.error('Error logging duty completion:', err));
            }
        } 
        // If staff is en route, send en route notification to hospital
        else if (status === 'enroute') {
            const MedicalStaff = require('../models/MedicalStaff');
            const staff = await MedicalStaff.findOne({ user: userId }).populate('user', 'name');
            
            if (staff) {
                // Try to calculate ETA if coordinates are available
                let eta = null;
                try {
                    const geocodingService = require('../services/geocoding.service');
                    const Hospital = require('../models/Hospital');
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
        }
        // If staff is on-site (in-progress), send on-site notification to hospital AND in-progress notification to staff
        else if (status === 'in-progress') {
            const MedicalStaff = require('../models/MedicalStaff');
            const staff = await MedicalStaff.findOne({ user: userId }).populate('user', 'name');
            
            if (staff) {
                // Send on-site notification to hospital
                await notificationEmitter.emitStaffOnSite(duty, staff, hospitalUserId);
                
                // Send in-progress notification to staff
                const Hospital = require('../models/Hospital');
                const hospital = await Hospital.findById(duty.hospital._id || duty.hospital);
                if (hospital) {
                    await notificationEmitter.emitDutyInProgress(duty, hospital, staffUserId);
                }
                
                // Log duty in-progress activity
                activityLogEmitter.logDutyStatusChange(duty, staff, status, req)
                    .catch(err => logger.error('Error logging duty in-progress:', err));
            }
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
    const dutyBeforeUpdate = await require('../models/Duty').findById(id).populate('assignedTo');

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

    const duty = await DutyService.editDuty(id, userId, updateData);

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
                isOvernightDuty: 'Overnight Duty'
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

    // Import cancellation service
    const CancellationService = require('../services/cancellation.service');

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
        // Handle specific error cases
        if (error.message.includes('Duty not found')) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }

        if (error.message.includes('cannot cancel') ||
            error.message.includes('Cannot cancel') ||
            error.message.includes('required') ||
            error.message.includes('Invalid cancellation reason')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        if (error.message.includes('can only cancel') ||
            error.message.includes('cannot cancel unassigned')) {
            return res.status(403).json({
                success: false,
                message: error.message
            });
        }

        // Re-throw other errors to be handled by global error handler
        throw error;
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
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});



// Get available jobs with distance for staff member
exports.getAvailableJobsWithDistance = asyncHandler(async (req, res) => {
    const staffId = req.user.id;
    const filters = req.query;

    const result = await DutyService.getAvailableJobsWithDistance(staffId, filters);

    // Additional safety check
    const availableJobs = result.jobs.filter(job => job.status === 'available');

    res.status(200).json({
        success: true,
        jobs: availableJobs,
        staffLocation: result.staffLocation,
        totalJobs: availableJobs.length
    });
});




exports.getCompletedDuties = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // Extract pagination parameters from query
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    const result = await DutyService.getCompletedDutiesForStaff(userId, page, limit);

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
        res.status(400).json({
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
        res.status(error.message.includes('not found') ? 404 : 400).json({
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

