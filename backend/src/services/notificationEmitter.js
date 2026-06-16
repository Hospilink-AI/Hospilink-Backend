const notificationService = require('./notificationService');
const websocketManager = require('./websocketManager');
const notificationDelivery = require('./notificationDelivery.service');
const geocodingService = require('./geocoding.service');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const logger = require('../utils/logger');



/**
 * Notification Emitter
 * Handles business logic for emitting notifications for duty lifecycle events
 */
class NotificationEmitter {
    /**
     * Emit duty created notification to matching staff AND hospital
     * @param {Object} duty - Duty object
     * @param {Object} hospital - Hospital object
     * @param {string[]} matchingStaffUserIds - Array of user IDs for matching staff
     * @param {string} hospitalUserId - Hospital user ID
     */
    async emitDutyCreated(duty, hospital, matchingStaffUserIds, hospitalUserId) {
        try {
            // Validate required parameters
            if (!duty || !hospital || !hospitalUserId) {
                console.error('Missing required parameters for emitDutyCreated');
                return;
            }

            const hospitalName = hospital.hospitalLegalName || hospital.user?.name || 'Hospital';
            const hospitalLocation = hospital.location || hospital.currentAddress || 'Hospital location';

            // Check if this is an emergency duty
            const isEmergency = duty.urgency === 'emergency';

            // Payload for hospital - different message for emergency vs regular
            let hospitalMessage;
            if (isEmergency) {
                // Count matching staff for emergency acknowledgment
                const staffCount = matchingStaffUserIds ? matchingStaffUserIds.length : 0;
                hospitalMessage = `Your emergency request for ${duty.staffRole} has been broadcast to ${staffCount} available staff within radius.`;
            } else {
                hospitalMessage = `Duty created successfully for ${duty.staffRole}`;
            }

            const hospitalPayload = {
                type: isEmergency ? 'EMERGENCY_REQUEST_ACKNOWLEDGED' : 'DUTY_CREATED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate,
                    urgency: duty.urgency,
                    description: duty.description,
                    location: hospitalLocation
                },
                hospital: {
                    id: hospital._id?.toString() || 'unknown',
                    name: hospitalName
                },
                message: hospitalMessage,
                timestamp: new Date().toISOString()
            };

            // Persist notification for hospital (creator)
            try {
                const hospitalNotificationType = isEmergency ? 'EMERGENCY_REQUEST_ACKNOWLEDGED' : 'DUTY_CREATED';
                const { unreadCount } = await notificationService.createNotificationWithCount(hospitalUserId, hospitalNotificationType, hospitalPayload);

                // Phase 3: Use delivery service for smart routing (WebSocket or FCM)
                await notificationDelivery.deliverToUser(hospitalUserId, hospitalNotificationType, hospitalPayload, unreadCount);
            } catch (error) {
                console.error(`Error creating notification for hospital ${hospitalUserId}:`, error);
            }

            // Create staff notification payload
            if (matchingStaffUserIds && matchingStaffUserIds.length > 0) {
                try {
                    // Format date and time
                    const dutyDate = new Date(duty.date).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric'
                    });
                    const dutyTime = `${duty.startTime} - ${duty.endTime}`;

                    // Check if this is an emergency duty
                    const isEmergency = duty.urgency === 'emergency';
                    const notificationType = isEmergency ? 'EMERGENCY_DUTY_REQUEST' : 'NEW_DUTY_OFFER';

                    // Create message based on urgency
                    let message;
                    if (isEmergency) {
                        message = `EMERGENCY: Immediate ${duty.staffRole} required at ${hospitalName} — ${hospitalLocation}. Critical response needed. Tap to accept.`;
                    } else {
                        message = `New duty available near you — ${duty.staffRole} at ${hospitalName}, ${dutyDate} ${dutyTime}. Tap to accept.`;
                    }

                    // Create staff payload for role room broadcast
                    const staffPayload = {
                        type: notificationType,
                        duty: {
                            id: duty._id.toString(),
                            staffRole: duty.staffRole,
                            date: duty.date,
                            startTime: duty.startTime,
                            endTime: duty.endTime,
                            offeredRate: duty.offeredRate,
                            urgency: duty.urgency,
                            description: duty.description,
                            location: hospitalLocation
                        },
                        hospital: {
                            id: hospital._id?.toString() || 'unknown',
                            name: hospitalName
                        },
                        message: message,
                        timestamp: new Date().toISOString()
                    };

                    // Persist notifications in bulk for all matching staff
                    await notificationService.createBulkNotifications(matchingStaffUserIds, notificationType, staffPayload);

                    // Broadcast to role room for real-time notification (online staff)
                    websocketManager.emitToStaffRole(duty.staffRole, 'notification', staffPayload);

                    // Phase 3: Smart delivery - WebSocket (online) + FCM (offline)
                    await notificationDelivery.deliverToUsers(matchingStaffUserIds, notificationType, staffPayload);

                    // Phase 2: Mark notifications as delivered for online staff
                    const onlineStaffIds = matchingStaffUserIds.filter(staffUserId =>
                        websocketManager.isUserOnline(staffUserId)
                    );

                    if (onlineStaffIds.length > 0) {
                        await notificationService.markDeliveredForUsers(
                            onlineStaffIds,
                            notificationType,
                            duty._id.toString()
                        );
                        console.log(`Marked ${onlineStaffIds.length}/${matchingStaffUserIds.length} staff notifications as delivered (online)`);
                    }

                    const notificationTypeLabel = isEmergency ? 'EMERGENCY_DUTY_REQUEST' : 'NEW_DUTY_OFFER';
                    console.log(`Duty created notification emitted to hospital and ${matchingStaffUserIds.length} staff members via role room (${notificationTypeLabel})`);
                } catch (error) {
                    console.error('Error creating staff notifications:', error);
                }
            }
        } catch (error) {
            console.error('Error emitting duty created notification:', error);
        }
    }

    /**
     * Emit duty accepted notification to hospital and staff
     * @param {Object} duty - Duty object
     * @param {Object} staff - Medical staff object
     * @param {string} hospitalUserId - Hospital user ID
     * @param {string} staffUserId - Staff user ID
     */
    async emitDutyAccepted(duty, staff, hospitalUserId, staffUserId) {
        try {
            const staffName = staff.fullName || staff.user?.name || 'Staff Member';

            // Get hospital details
            const hospital = await Hospital.findById(duty.hospital._id || duty.hospital);
            const hospitalName = hospital?.hospitalLegalName || duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'Hospital';
            const hospitalLocation = hospital?.location || hospital?.currentAddress || 'the hospital';

            // Format date
            const dutyDate = new Date(duty.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });

            // Format time
            const reportTime = duty.startTime;

            // Calculate ETA for hospital notification
            let etaText = 'Calculating...';
            try {
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
                    etaText = `${distanceInfo.duration} mins`;
                }
            } catch (error) {
                console.error('Error calculating ETA:', error);
            }

            // Payload for staff (DUTY_CONFIRMED)
            const staffPayload = {
                type: 'DUTY_CONFIRMED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate,
                    location: hospitalLocation
                },
                hospital: {
                    name: hospitalName,
                    location: hospitalLocation
                },
                message: `Duty confirmed! ${duty.staffRole} at ${hospitalName} on ${dutyDate}. Report to ${hospitalLocation} by ${reportTime}. Tap for full details.`,
                acceptedAt: duty.assignedAt || new Date().toISOString(),
                timestamp: new Date().toISOString()
            };

            // Payload for hospital (STAFF_ASSIGNED)
            const hospitalPayload = {
                type: 'STAFF_ASSIGNED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate,
                    location: hospitalLocation
                },
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: duty.staffRole
                },
                message: `${staffName} (${duty.staffRole}) has accepted your duty request for ${dutyDate} at ${hospitalLocation}. ETA: ${etaText}.`,
                acceptedAt: duty.assignedAt || new Date().toISOString(),
                timestamp: new Date().toISOString()
            };

            // Persist notification for hospital (isolated try-catch)
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(hospitalUserId, 'STAFF_ASSIGNED', hospitalPayload);
                await notificationDelivery.deliverToUser(hospitalUserId, 'STAFF_ASSIGNED', hospitalPayload, unreadCount);
                console.log(`Staff assigned notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending staff assigned notification to hospital ${hospitalUserId}:`, error);
            }

            // Persist notification for staff (isolated try-catch)
            try {
                console.log(`Attempting to send DUTY_CONFIRMED to staff ${staffUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(staffUserId, 'DUTY_CONFIRMED', staffPayload);
                console.log(`DUTY_CONFIRMED notification created in DB for staff ${staffUserId}, unread count: ${unreadCount}`);
                await notificationDelivery.deliverToUser(staffUserId, 'DUTY_CONFIRMED', staffPayload, unreadCount);
                console.log(`Duty confirmed notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending duty confirmed notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting duty accepted notification:', error);
        }
    }

    /**
     * Emit staff en route notification to hospital
     * @param {Object} duty - Duty object
     * @param {Object} staff - Medical staff object
     * @param {string} hospitalUserId - Hospital user ID
     * @param {string} eta - Estimated time of arrival
     */
    async emitStaffEnRoute(duty, staff, hospitalUserId, eta = null) {
        try {
            // Validate required parameters
            if (!duty || !staff || !hospitalUserId) {
                console.error('Missing required parameters for emitStaffEnRoute');
                return;
            }

            const staffName = staff.fullName || staff.user?.name || 'Staff Member';

            // Get hospital details
            const hospital = await Hospital.findById(duty.hospital._id || duty.hospital);
            const hospitalName = hospital?.hospitalLegalName || duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'Hospital';

            // Format ETA text
            let etaText = eta || 'Calculating...';
            if (eta && typeof eta === 'number') {
                etaText = `${eta} mins`;
            }

            const payload = {
                type: 'STAFF_EN_ROUTE',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime
                },
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: duty.staffRole
                },
                hospital: {
                    name: hospitalName
                },
                eta: etaText,
                message: `${staffName} is on the way — estimated arrival in ${etaText}. Track in the Live Map.`,
                timestamp: new Date().toISOString()
            };

            // Persist notification for hospital
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    hospitalUserId,
                    'STAFF_EN_ROUTE',
                    payload
                );

                await notificationDelivery.deliverToUser(hospitalUserId, 'STAFF_EN_ROUTE', payload, unreadCount);

                console.log(`Staff en route notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending staff en route notification to hospital ${hospitalUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting staff en route notification:', error);
        }
    }

    /**
     * Emit staff on-site notification to hospital
     * @param {Object} duty - Duty object
     * @param {Object} staff - Medical staff object
     * @param {string} hospitalUserId - Hospital user ID
     */
    async emitStaffOnSite(duty, staff, hospitalUserId) {
        try {
            // Validate required parameters
            if (!duty || !staff || !hospitalUserId) {
                console.error('Missing required parameters for emitStaffOnSite');
                return;
            }

            const staffName = staff.fullName || staff.user?.name || 'Staff Member';

            // Get hospital details
            const hospital = await Hospital.findById(duty.hospital._id || duty.hospital);
            const hospitalName = hospital?.hospitalLegalName || duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'Hospital';

            // Get last 6 characters of duty ID for display
            const dutyIdShort = duty._id.toString().slice(-6);

            const payload = {
                type: 'STAFF_ON_SITE',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime
                },
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: duty.staffRole
                },
                hospital: {
                    name: hospitalName
                },
                message: `${staffName} has arrived at ${hospitalName}. Duty #${dutyIdShort} is now In Progress.`,
                timestamp: new Date().toISOString()
            };

            // Persist notification for hospital
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    hospitalUserId,
                    'STAFF_ON_SITE',
                    payload
                );

                await notificationDelivery.deliverToUser(hospitalUserId, 'STAFF_ON_SITE', payload, unreadCount);

                console.log(`Staff on-site notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending staff on-site notification to hospital ${hospitalUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting staff on-site notification:', error);
        }
    }

    /**
     * Emit navigate to duty reminder notification to staff
     * @param {Object} duty - Duty object
     * @param {Object} staff - Medical staff object
     * @param {string} staffUserId - Staff user ID
     */
    async emitNavigateToDuty(duty, staff, staffUserId) {
        try {
            // Validate required parameters
            if (!duty || !staff || !staffUserId) {
                console.error('Missing required parameters for emitNavigateToDuty');
                return;
            }

            // Get hospital details
            const hospital = await Hospital.findById(duty.hospital._id || duty.hospital);
            const hospitalName = hospital?.hospitalLegalName || duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'Hospital';

            const payload = {
                type: 'NAVIGATE_TO_DUTY',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime
                },
                hospital: {
                    id: hospital?._id?.toString() || 'unknown',
                    name: hospitalName
                },
                message: `Your duty starts in 30 minutes — ${hospitalName}. Tap to open navigation.`,
                timestamp: new Date().toISOString()
            };

            // Persist notification for staff
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    staffUserId,
                    'NAVIGATE_TO_DUTY',
                    payload
                );

                await notificationDelivery.deliverToUser(staffUserId, 'NAVIGATE_TO_DUTY', payload, unreadCount);

                console.log(`Navigate to duty notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending navigate to duty notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting navigate to duty notification:', error);
        }
    }

    /**
     * Emit duty cancelled notification
     * @param {Object} duty - Duty object
     * @param {Object} cancelledByUser - User who cancelled the duty
     * @param {string} reason - Cancellation reason
     * @param {string} reasonText - Additional reason text
     * @param {string[]} recipientUserIds - Array of recipient user IDs
     */
    async emitDutyCancelled(duty, cancelledByUser, reason, reasonText, recipientUserIds) {
        try {
            // Get hospital details
            const hospital = await Hospital.findById(duty.hospital._id || duty.hospital);
            const hospitalName = hospital?.hospitalLegalName || duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'Hospital';

            // Format date
            const dutyDate = new Date(duty.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });

            // Format reason text
            const reasonDisplay = reasonText || reason.replace(/_/g, ' ');

            // Determine who cancelled (hospital or staff)
            const cancelledByRole = cancelledByUser.role;

            // Create personalized notifications for each recipient
            for (const recipientUserId of recipientUserIds) {
                try {
                    let notificationType;
                    let message;

                    // If hospital cancelled, send to staff
                    if (cancelledByRole === 'hospital') {
                        notificationType = 'DUTY_CANCELLED_BY_HOSPITAL';
                        message = `Your upcoming duty on ${dutyDate} at ${hospitalName} has been cancelled. Reason: ${reasonDisplay}. Check the app for alternatives.`;
                    }
                    // If staff cancelled, send to hospital
                    else if (cancelledByRole === 'staff') {
                        notificationType = 'DUTY_CANCELLED_BY_STAFF';
                        const staffName = cancelledByUser.name || 'Staff member';
                        message = `${staffName} has cancelled the duty for ${dutyDate}. Reason: ${reasonDisplay}. Please reassign or post again.`;
                    }
                    // Fallback for other roles (admin, etc.)
                    else {
                        notificationType = 'DUTY_CANCELLED_BY_HOSPITAL';
                        message = `Duty on ${dutyDate} at ${hospitalName} has been cancelled. Reason: ${reasonDisplay}.`;
                    }

                    const payload = {
                        type: notificationType,
                        duty: {
                            id: duty._id.toString(),
                            staffRole: duty.staffRole,
                            date: duty.date,
                            startTime: duty.startTime,
                            endTime: duty.endTime
                        },
                        hospital: {
                            name: hospitalName
                        },
                        cancelledBy: {
                            id: cancelledByUser._id.toString(),
                            name: cancelledByUser.name,
                            role: cancelledByUser.role
                        },
                        reason: reason,
                        reasonText: reasonText || null,
                        message: message,
                        timestamp: new Date().toISOString()
                    };

                    // Create notification with count
                    const { unreadCount } = await notificationService.createNotificationWithCount(
                        recipientUserId,
                        notificationType,
                        payload
                    );

                    // Deliver via smart routing (WebSocket or FCM)
                    await notificationDelivery.deliverToUser(recipientUserId, notificationType, payload, unreadCount);

                    console.log(`Duty cancelled notification (${notificationType}) sent to user ${recipientUserId}`);
                } catch (error) {
                    console.error(`Error creating cancellation notification for user ${recipientUserId}:`, error);
                }
            }

            console.log(`Duty cancelled notifications emitted to ${recipientUserIds.length} recipients`);
        } catch (error) {
            console.error('Error emitting duty cancelled notification:', error);
        }
    }

    /**
     * Emit duty edited notification to assigned staff
     * @param {Object} duty - Duty object
     * @param {Object} changes - Object containing changed fields
     * @param {string} staffUserId - Staff user ID
     */
    async emitDutyEdited(duty, changes, staffUserId) {
        try {
            const payload = {
                type: 'DUTY_EDITED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate
                },
                changes: changes,
                timestamp: new Date().toISOString()
            };

            // Persist notification for staff
            const { unreadCount } = await notificationService.createNotificationWithCount(staffUserId, 'DUTY_EDITED', payload);

            // Deliver via smart routing (WebSocket or FCM)
            await notificationDelivery.deliverToUser(staffUserId, 'DUTY_EDITED', payload, unreadCount);

            console.log(`Duty edited notification emitted to staff ${staffUserId}`);
        } catch (error) {
            console.error('Error emitting duty edited notification:', error);
        }
    }


    async emitReviewReceived(duty, hospital, staff, rating, reviewText) {
        try {
            const payload = {
                type: 'REVIEW_RECEIVED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime
                },
                hospital: {
                    id: hospital._id.toString(),
                    name: hospital.hospitalLegalName || hospital.user?.name
                },
                rating: rating,
                review: reviewText ? reviewText : "",
                message: reviewText
                    ? `You received a ${rating}⭐ review: "${reviewText}"` : `You received a ${rating}⭐ rating from hospital`,
                timestamp: new Date().toISOString()
            };

            const staffUserId = staff.user.toString();

            // Save notification
            const { unreadCount } = await notificationService.createNotificationWithCount(
                staffUserId,
                'REVIEW_RECEIVED',
                payload
            );

            // Deliver via smart routing (WebSocket or FCM)
            await notificationDelivery.deliverToUser(staffUserId, 'REVIEW_RECEIVED', payload, unreadCount);

            console.log(`Review notification sent to staff ${staffUserId}`);

        } catch (error) {
            console.error('Error emitting review notification:', error);
        }
    }

    /**
     * Emit duty in-progress notification to staff
     * @param {Object} duty - Duty object
     * @param {Object} hospital - Hospital object
     * @param {string} staffUserId - Staff user ID
     */
    async emitDutyInProgress(duty, hospital, staffUserId) {
        try {
            // Validate required parameters
            if (!duty || !hospital || !staffUserId) {
                console.error('Missing required parameters for emitDutyInProgress');
                return;
            }

            const hospitalName = hospital.hospitalLegalName || hospital.user?.name || 'Hospital';
            const hospitalLocation = hospital.location || hospital.currentAddress || 'the hospital';

            // Get last 6 characters of duty ID for display
            const dutyIdShort = duty._id.toString().slice(-6);

            const payload = {
                type: 'DUTY_IN_PROGRESS',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate,
                    location: hospitalLocation
                },
                hospital: {
                    id: hospital._id?.toString() || 'unknown',
                    name: hospitalName,
                    location: hospitalLocation
                },
                message: `Duty #${dutyIdShort} is now in progress at ${hospitalName}. Remember to mark complete when finished.`,
                timestamp: new Date().toISOString()
            };

            // Persist notification for staff
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    staffUserId,
                    'DUTY_IN_PROGRESS',
                    payload
                );

                await notificationDelivery.deliverToUser(staffUserId, 'DUTY_IN_PROGRESS', payload, unreadCount);

                console.log(`Duty in-progress notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending duty in-progress notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting duty in-progress notification:', error);
        }
    }

    /**
     * Emit duty completed notification to hospital
     * @param {Object} duty - Duty object
     * @param {Object} staff - Medical staff object
     * @param {string} hospitalUserId - Hospital user ID
     */
    async emitDutyCompleted(duty, staff, hospitalUserId) {
        try {
            // Validate required parameters
            if (!duty || !staff || !hospitalUserId) {
                console.error('Missing required parameters for emitDutyCompleted');
                return;
            }

            const staffName = staff.fullName || staff.user?.name || 'Staff Member';

            // Get hospital details for location/ward info
            const hospital = await Hospital.findById(duty.hospital._id || duty.hospital);
            const hospitalLocation = hospital?.location || hospital?.currentAddress || 'the hospital';

            const payload = {
                type: 'DUTY_COMPLETED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    location: hospitalLocation
                },
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: duty.staffRole
                },
                message: `Duty #${duty._id.toString().slice(-6)} at ${hospitalLocation} has been completed by ${staffName}. Please rate their performance.`,
                completedAt: new Date().toISOString(),
                timestamp: new Date().toISOString()
            };

            // Persist notification for hospital
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    hospitalUserId,
                    'DUTY_COMPLETED',
                    payload
                );

                await notificationDelivery.deliverToUser(hospitalUserId, 'DUTY_COMPLETED', payload, unreadCount);

                console.log(`Duty completed notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending duty completed notification to hospital ${hospitalUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting duty completed notification:', error);
        }
    }

    /**
     * Emit new hospital registration notification to admin
     * @param {Object} hospital - Hospital object
     * @param {Object} user - User object
     */
    async emitNewHospitalRegistration(hospital, user) {
        try {
            // Validate required parameters
            if (!hospital || !user) {
                console.error('Missing required parameters for emitNewHospitalRegistration');
                return;
            }

            const hospitalName = hospital.hospitalLegalName || user.name || 'New Hospital';
            const location = hospital.location || hospital.currentAddress || 'Location not provided';

            const payload = {
                type: 'NEW_HOSPITAL_REGISTRATION',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName,
                    location: location,
                    email: user.email,
                    phone: user.phone || 'Not provided'
                },
                user: {
                    id: user._id.toString(),
                    name: user.name,
                    email: user.email
                },
                message: `New hospital registered: ${hospitalName} at ${location}. Review and approve the registration.`,
                timestamp: new Date().toISOString()
            };

            // Get all admin users
            const adminUsers = await User.find({ role: 'admin' }).select('_id');

            if (adminUsers.length === 0) {
                console.log('No admin users found to notify');
                return;
            }

            const adminUserIds = adminUsers.map(admin => admin._id.toString());

            // Persist notifications for all admins
            try {
                await notificationService.createBulkNotifications(adminUserIds, 'NEW_HOSPITAL_REGISTRATION', payload);

                // Deliver to all admins via smart routing (WebSocket or FCM)
                await notificationDelivery.deliverToUsers(adminUserIds, 'NEW_HOSPITAL_REGISTRATION', payload);

                console.log(`New hospital registration notification sent to ${adminUserIds.length} admins`);
            } catch (error) {
                console.error('Error sending hospital registration notifications:', error);
            }
        } catch (error) {
            console.error('Error emitting new hospital registration notification:', error);
        }
    }

    /**
     * Emit new staff registration notification to admin
     * @param {Object} staff - Medical staff object
     * @param {Object} user - User object
     */
    async emitNewStaffRegistration(staff, user) {
        try {
            // Validate required parameters
            if (!staff || !user) {
                console.error('Missing required parameters for emitNewStaffRegistration');
                return;
            }

            const staffName = staff.fullName || user.name || 'New Staff Member';
            const jobRole = staff.jobRole || 'Not specified';

            const payload = {
                type: 'NEW_STAFF_REGISTRATION',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    jobRole: jobRole,
                    email: user.email,
                    phone: user.phone || 'Not provided',
                    experience: staff.experience || 'Not provided'
                },
                user: {
                    id: user._id.toString(),
                    name: user.name,
                    email: user.email
                },
                message: `New ${jobRole} registered: ${staffName}. Review and verify the profile.`,
                timestamp: new Date().toISOString()
            };

            // Get all admin users
            const adminUsers = await User.find({ role: 'admin' }).select('_id');

            if (adminUsers.length === 0) {
                console.log('No admin users found to notify');
                return;
            }

            const adminUserIds = adminUsers.map(admin => admin._id.toString());

            // Persist notifications for all admins
            try {
                await notificationService.createBulkNotifications(adminUserIds, 'NEW_STAFF_REGISTRATION', payload);

                // Deliver to all admins via smart routing (WebSocket or FCM)
                await notificationDelivery.deliverToUsers(adminUserIds, 'NEW_STAFF_REGISTRATION', payload);

                console.log(`New staff registration notification sent to ${adminUserIds.length} admins`);
            } catch (error) {
                console.error('Error sending staff registration notifications:', error);
            }
        } catch (error) {
            console.error('Error emitting new staff registration notification:', error);
        }
    }



    /**
     * Emit hospital profile verified notification
     * @param {Object} hospital - Hospital object
     * @param {string} hospitalUserId - Hospital user ID
     */
    async emitHospitalVerified(hospital, hospitalUserId) {
        try {
            console.log(`[NOTIFICATION] Starting hospital verified notification process for hospital: ${hospitalUserId}`);

            // Get all admin users
            const admins = await User.find({ role: 'admin' }).select('_id');
            const adminIds = admins.map(a => a._id.toString());
            console.log(`[NOTIFICATION] Found ${adminIds.length} admins to notify`);

            const hospitalName = hospital.hospitalLegalName || hospital.user?.name || 'Hospital';

            // Payload for hospital user
            const hospitalPayload = {
                type: 'HOSPITAL_VERIFIED',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName
                },
                message: `Your hospital profile "${hospitalName}" has been verified. You can now post duties and access all features.`,
                timestamp: new Date().toISOString()
            };

            // Payload for admins
            const adminPayload = {
                type: 'HOSPITAL_VERIFIED_ADMIN',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName
                },
                message: `Hospital "${hospitalName}" has been verified by admin.`,
                timestamp: new Date().toISOString()
            };

            // Send notification to hospital user
            try {
                console.log(`[NOTIFICATION] Sending verification notification to hospital user: ${hospitalUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    hospitalUserId,
                    'HOSPITAL_VERIFIED',
                    hospitalPayload
                );
                await notificationDelivery.deliverToUser(hospitalUserId, 'HOSPITAL_VERIFIED', hospitalPayload, unreadCount);
                console.log(`[NOTIFICATION] ✓ Successfully sent verification notification to hospital user: ${hospitalUserId}`);
            } catch (error) {
                console.error(`[NOTIFICATION] ✗ Error sending verification notification to hospital ${hospitalUserId}:`, error);
            }

            // Send notifications to all admins
            if (adminIds.length > 0) {
                try {
                    console.log(`[NOTIFICATION] Sending verification notification to ${adminIds.length} admins`);
                    await notificationService.createBulkNotifications(adminIds, 'HOSPITAL_VERIFIED_ADMIN', adminPayload);
                    await notificationDelivery.deliverToUsers(adminIds, 'HOSPITAL_VERIFIED_ADMIN', adminPayload);
                    console.log(`[NOTIFICATION] ✓ Successfully sent verification notification to ${adminIds.length} admins`);
                } catch (error) {
                    console.error('[NOTIFICATION] ✗ Error sending hospital verified notification to admins:', error);
                }
            } else {
                console.log(`[NOTIFICATION] ⚠ No admins found to notify`);
            }

            console.log(`[NOTIFICATION] ✓ Hospital verified notification process completed: hospital=${hospitalUserId}, admins=${adminIds.length}`);
        } catch (error) {
            console.error('[NOTIFICATION] ✗ Error emitting hospital verified notification:', error);
        }
    }

    /**
     * Emit hospital profile rejected notification
     * @param {Object} hospital - Hospital object
     * @param {string} hospitalUserId - Hospital user ID
     * @param {string} reason - Rejection reason
     */
    async emitHospitalRejected(hospital, hospitalUserId, reason) {
        try {
            console.log(`[NOTIFICATION] Starting hospital rejected notification process for hospital: ${hospitalUserId}, reason: ${reason}`);

            // Get all admin users
            const admins = await User.find({ role: 'admin' }).select('_id');
            const adminIds = admins.map(a => a._id.toString());
            console.log(`[NOTIFICATION] Found ${adminIds.length} admins to notify`);

            const hospitalName = hospital.hospitalLegalName || hospital.user?.name || 'Hospital';

            // Payload for hospital user
            const hospitalPayload = {
                type: 'HOSPITAL_REJECTED',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName
                },
                rejectionReason: reason,
                message: `Your hospital profile "${hospitalName}" was rejected. Reason: ${reason}. Please update your profile and resubmit.`,
                timestamp: new Date().toISOString()
            };

            // Payload for admins
            const adminPayload = {
                type: 'HOSPITAL_REJECTED_ADMIN',
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName
                },
                rejectionReason: reason,
                message: `Hospital "${hospitalName}" has been rejected. Reason: ${reason}.`,
                timestamp: new Date().toISOString()
            };

            // Send notification to hospital user
            try {
                console.log(`[NOTIFICATION] Sending rejection notification to hospital user: ${hospitalUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    hospitalUserId,
                    'HOSPITAL_REJECTED',
                    hospitalPayload
                );
                await notificationDelivery.deliverToUser(hospitalUserId, 'HOSPITAL_REJECTED', hospitalPayload, unreadCount);
                console.log(`[NOTIFICATION] ✓ Successfully sent rejection notification to hospital user: ${hospitalUserId}`);
            } catch (error) {
                console.error(`[NOTIFICATION] ✗ Error sending rejection notification to hospital ${hospitalUserId}:`, error);
            }

            // Send notifications to all admins
            if (adminIds.length > 0) {
                try {
                    console.log(`[NOTIFICATION] Sending rejection notification to ${adminIds.length} admins`);
                    await notificationService.createBulkNotifications(adminIds, 'HOSPITAL_REJECTED_ADMIN', adminPayload);
                    await notificationDelivery.deliverToUsers(adminIds, 'HOSPITAL_REJECTED_ADMIN', adminPayload);
                    console.log(`[NOTIFICATION] ✓ Successfully sent rejection notification to ${adminIds.length} admins`);
                } catch (error) {
                    console.error('[NOTIFICATION] ✗ Error sending hospital rejected notification to admins:', error);
                }
            } else {
                console.log(`[NOTIFICATION] ⚠ No admins found to notify`);
            }

            console.log(`[NOTIFICATION] ✓ Hospital rejected notification process completed: hospital=${hospitalUserId}, admins=${adminIds.length}`);
        } catch (error) {
            console.error('[NOTIFICATION] ✗ Error emitting hospital rejected notification:', error);
        }
    }

    /**
     * Emit staff profile verified notification
     * @param {Object} staff - Medical staff object
     * @param {string} staffUserId - Staff user ID
     */
    async emitStaffVerified(staff, staffUserId) {
        try {
            console.log(`[NOTIFICATION] Starting staff verified notification process for staff: ${staffUserId}`);

            // Get all admin users
            const admins = await User.find({ role: 'admin' }).select('_id');
            const adminIds = admins.map(a => a._id.toString());
            console.log(`[NOTIFICATION] Found ${adminIds.length} admins to notify`);

            const staffName = staff.fullName || staff.user?.name || 'Staff Member';

            // Payload for staff user
            const staffPayload = {
                type: 'STAFF_VERIFIED',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: staff.jobRole
                },
                message: `Your profile "${staffName}" has been verified. You can now apply for duties and access all features.`,
                timestamp: new Date().toISOString()
            };

            // Payload for admins
            const adminPayload = {
                type: 'STAFF_VERIFIED_ADMIN',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: staff.jobRole
                },
                message: `Staff "${staffName}" (${staff.jobRole}) has been verified by admin.`,
                timestamp: new Date().toISOString()
            };

            // Send notification to staff user
            try {
                console.log(`[NOTIFICATION] Sending verification notification to staff user: ${staffUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    staffUserId,
                    'STAFF_VERIFIED',
                    staffPayload
                );
                await notificationDelivery.deliverToUser(staffUserId, 'STAFF_VERIFIED', staffPayload, unreadCount);
                console.log(`[NOTIFICATION] ✓ Successfully sent verification notification to staff user: ${staffUserId}`);
            } catch (error) {
                console.error(`[NOTIFICATION] ✗ Error sending verification notification to staff ${staffUserId}:`, error);
            }

            // Send notifications to all admins
            if (adminIds.length > 0) {
                try {
                    console.log(`[NOTIFICATION] Sending verification notification to ${adminIds.length} admins`);
                    await notificationService.createBulkNotifications(adminIds, 'STAFF_VERIFIED_ADMIN', adminPayload);
                    await notificationDelivery.deliverToUsers(adminIds, 'STAFF_VERIFIED_ADMIN', adminPayload);
                    console.log(`[NOTIFICATION] ✓ Successfully sent verification notification to ${adminIds.length} admins`);
                } catch (error) {
                    console.error('[NOTIFICATION] ✗ Error sending staff verified notification to admins:', error);
                }
            } else {
                console.log(`[NOTIFICATION] ⚠ No admins found to notify`);
            }

            console.log(`[NOTIFICATION] ✓ Staff verified notification process completed: staff=${staffUserId}, admins=${adminIds.length}`);
        } catch (error) {
            console.error('[NOTIFICATION] ✗ Error emitting staff verified notification:', error);
        }
    }

    /**
     * Emit staff profile rejected notification
     * @param {Object} staff - Medical staff object
     * @param {string} staffUserId - Staff user ID
     * @param {string} reason - Rejection reason
     */
    async emitStaffRejected(staff, staffUserId, reason) {
        try {
            console.log(`[NOTIFICATION] Starting staff rejected notification process for staff: ${staffUserId}, reason: ${reason}`);

            // Get all admin users
            const admins = await User.find({ role: 'admin' }).select('_id');
            const adminIds = admins.map(a => a._id.toString());
            console.log(`[NOTIFICATION] Found ${adminIds.length} admins to notify`);

            const staffName = staff.fullName || staff.user?.name || 'Staff Member';

            // Payload for staff user
            const staffPayload = {
                type: 'STAFF_REJECTED',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: staff.jobRole
                },
                rejectionReason: reason,
                message: `Your profile "${staffName}" was rejected. Reason: ${reason}. Please update your profile and resubmit.`,
                timestamp: new Date().toISOString()
            };

            // Payload for admins
            const adminPayload = {
                type: 'STAFF_REJECTED_ADMIN',
                staff: {
                    id: staff._id.toString(),
                    name: staffName,
                    role: staff.jobRole
                },
                rejectionReason: reason,
                message: `Staff "${staffName}" (${staff.jobRole}) has been rejected. Reason: ${reason}.`,
                timestamp: new Date().toISOString()
            };

            // Send notification to staff user
            try {
                console.log(`[NOTIFICATION] Sending rejection notification to staff user: ${staffUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    staffUserId,
                    'STAFF_REJECTED',
                    staffPayload
                );
                await notificationDelivery.deliverToUser(staffUserId, 'STAFF_REJECTED', staffPayload, unreadCount);
                console.log(`[NOTIFICATION] ✓ Successfully sent rejection notification to staff user: ${staffUserId}`);
            } catch (error) {
                console.error(`[NOTIFICATION] ✗ Error sending rejection notification to staff ${staffUserId}:`, error);
            }

            // Send notifications to all admins
            if (adminIds.length > 0) {
                try {
                    console.log(`[NOTIFICATION] Sending rejection notification to ${adminIds.length} admins`);
                    await notificationService.createBulkNotifications(adminIds, 'STAFF_REJECTED_ADMIN', adminPayload);
                    await notificationDelivery.deliverToUsers(adminIds, 'STAFF_REJECTED_ADMIN', adminPayload);
                    console.log(`[NOTIFICATION] ✓ Successfully sent rejection notification to ${adminIds.length} admins`);
                } catch (error) {
                    console.error('[NOTIFICATION] ✗ Error sending staff rejected notification to admins:', error);
                }
            } else {
                console.log(`[NOTIFICATION] ⚠ No admins found to notify`);
            }

            console.log(`[NOTIFICATION] ✓ Staff rejected notification process completed: staff=${staffUserId}, admins=${adminIds.length}`);
        } catch (error) {
            console.error('[NOTIFICATION] ✗ Error emitting staff rejected notification:', error);
        }
    }



    // Document verification notifications
    async emitDocumentVerified(document, userRole) {
        try {
            if (!document || !document.userId) {
                console.error('Missing required parameters for emitDocumentVerified');
                return;
            }

            const documentType = document.documentType.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

            const payload = {
                type: 'DOCUMENT_VERIFIED',
                document: {
                    id: document.documentId,
                    type: document.documentType,
                    typeName: documentType,
                    verifiedAt: document.verifiedAt
                },
                message: `Your ${documentType} has been verified by the HospiLink team`,
                timestamp: new Date().toISOString()
            };

            // Persist notification for user
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    document.userId,
                    'DOCUMENT_VERIFIED',
                    payload
                );

                await notificationDelivery.deliverToUser(document.userId, 'DOCUMENT_VERIFIED', payload, unreadCount);

                console.log(`Document verified notification sent to ${userRole} ${document.userId}`);
            } catch (error) {
                console.error(`Error sending document verified notification to ${userRole} ${document.userId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting document verified notification:', error);
        }
    }



    // Document rejection notifications
    async emitDocumentRejected(document, userRole) {
        try {
            if (!document || !document.userId) {
                console.error('Missing required parameters for emitDocumentRejected');
                return;
            }

            const documentType = document.documentType.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            const rejectionReason = document.rejectionReason || 'No reason provided';

            const payload = {
                type: 'DOCUMENT_REJECTED',
                document: {
                    id: document.documentId,
                    type: document.documentType,
                    typeName: documentType,
                    rejectionReason: rejectionReason,
                    rejectedAt: document.verifiedAt
                },
                message: `Your ${documentType} was not accepted. Reason: ${rejectionReason}. Please re-upload a clear, valid document.`,
                timestamp: new Date().toISOString()
            };

            // Persist notification for user
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    document.userId,
                    'DOCUMENT_REJECTED',
                    payload
                );

                await notificationDelivery.deliverToUser(document.userId, 'DOCUMENT_REJECTED', payload, unreadCount);

                console.log(`Document rejected notification sent to ${userRole} ${document.userId}`);
            } catch (error) {
                console.error(`Error sending document rejected notification to ${userRole} ${document.userId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting document rejected notification:', error);
        }
    }

    /**
     * Emit duty unassigned 15-minute warning to hospital (HIGH priority)
     * Triggered when duty has been live for 15 minutes with no acceptance
     * @param {Object} duty - Duty object (populated with hospital)
     * @param {string} hospitalUserId - Hospital user ID
     */
    async emitDutyUnassigned15Min(duty, hospitalUserId) {
        try {
            if (!duty || !hospitalUserId) {
                console.error('Missing required parameters for emitDutyUnassigned15Min');
                return;
            }

            const ward = duty.ward || duty.location || 'your ward';
            const date = new Date(duty.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

            const payload = {
                type: 'DUTY_UNASSIGNED_15MIN',
                priority: 'HIGH',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    ward
                },
                message: `No staff assigned yet for your ${duty.staffRole} request at ${ward} on ${date}. Broaden the search radius or post as urgent?`,
                timestamp: new Date().toISOString()
            };

            const { unreadCount } = await notificationService.createNotificationWithCount(
                hospitalUserId,
                'DUTY_UNASSIGNED_15MIN',
                payload
            );

            await notificationDelivery.deliverToUser(hospitalUserId, 'DUTY_UNASSIGNED_15MIN', payload, unreadCount);

            console.log(`Duty unassigned 15-min notification sent to hospital ${hospitalUserId} for duty ${duty._id}`);
        } catch (error) {
            console.error('Error emitting duty unassigned 15-min notification:', error);
        }
    }

    /**
     * Emit duty unfilled critical alert to hospital (CRITICAL priority)
     * Triggered when duty is still unassigned 30 minutes before shift start
     * @param {Object} duty - Duty object (populated with hospital)
     * @param {string} hospitalUserId - Hospital user ID
     * @param {number} minutesToShift - Minutes remaining until shift start
     */
    async emitDutyUnfilledCritical(duty, hospitalUserId, minutesToShift) {
        try {
            if (!duty || !hospitalUserId) {
                console.error('Missing required parameters for emitDutyUnfilledCritical');
                return;
            }

            const ward = duty.ward || duty.location || 'your ward';

            const payload = {
                type: 'DUTY_UNFILLED_CRITICAL',
                priority: 'CRITICAL',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    ward
                },
                message: `ALERT: Your ${duty.staffRole} request at ${ward} remains unfilled with ${minutesToShift} minutes until shift start. Immediate action required.`,
                timestamp: new Date().toISOString()
            };

            const { unreadCount } = await notificationService.createNotificationWithCount(
                hospitalUserId,
                'DUTY_UNFILLED_CRITICAL',
                payload
            );

            await notificationDelivery.deliverToUser(hospitalUserId, 'DUTY_UNFILLED_CRITICAL', payload, unreadCount);

            console.log(`Duty unfilled CRITICAL notification sent to hospital ${hospitalUserId} for duty ${duty._id}`);
        } catch (error) {
            console.error('Error emitting duty unfilled critical notification:', error);
        }
    }

    /**
     * Emit emergency/critical alert to all admin users
     * @param {Object} duty - Duty object
     * @param {Object} hospital - Hospital object
     * @param {string[]} adminUserIds - Array of admin user IDs
     * @param {string} reason - 'emergency_created' | 'escalated'
     */
    async emitEmergencyAdminAlert(duty, hospital, adminUserIds, reason) {
        try {
            if (!adminUserIds || adminUserIds.length === 0) return;

            const hospitalName = hospital.hospitalLegalName || hospital.name || 'Hospital';
            const isEscalated = reason === 'escalated';

            const message = isEscalated
                ? `CRITICAL ESCALATION: Unassigned ${duty.staffRole} duty at ${hospitalName} starts within 1 hour. Immediate action required.`
                : `EMERGENCY DUTY: ${duty.staffRole} required at ${hospitalName} on ${new Date(duty.date).toLocaleDateString('en-IN')} at ${duty.startTime}. Immediate attention needed.`;

            const payload = {
                type: 'EMERGENCY_ADMIN_ALERT',
                alertReason: reason,
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    urgency: duty.urgency,
                    status: duty.status
                },
                hospital: {
                    id: hospital._id?.toString(),
                    name: hospitalName
                },
                message,
                timestamp: new Date().toISOString()
            };

            for (const adminId of adminUserIds) {
                try {
                    const { unreadCount } = await notificationService.createNotificationWithCount(adminId, 'EMERGENCY_ADMIN_ALERT', payload);
                    await notificationDelivery.deliverToUser(adminId, 'EMERGENCY_ADMIN_ALERT', payload, unreadCount);
                } catch (err) {
                    console.error(`Error sending emergency alert to admin ${adminId}:`, err);
                }
            }

            console.log(`Emergency admin alert (${reason}) sent to ${adminUserIds.length} admin(s) for duty ${duty._id}`);
        } catch (error) {
            console.error('Error emitting emergency admin alert:', error);
        }
    }

    async emitAccountSuspended(profile, userId, role, reason) {
        try {
            const payload = {
                type: 'ACCOUNT_SUSPENDED',
                reason,
                message: `Your account has been suspended. Reason: ${reason}. Please contact support.`,
                timestamp: new Date().toISOString()
            };

            const { unreadCount } =
                await notificationService.createNotificationWithCount(
                    userId,
                    'ACCOUNT_SUSPENDED',
                    payload
                );

            await notificationDelivery.deliverToUser(
                userId,
                'ACCOUNT_SUSPENDED',
                payload,
                unreadCount
            );

            logger.info(`Account suspended notification sent to ${role} user ${userId}`);
        } catch (error) {
            logger.error('Error emitting account suspended notification:', error);
        }
    }

    async emitAccountActivated(profile, userId, role) {
        try {
            const payload = {
                type: 'ACCOUNT_ACTIVATED',
                message: 'Your account has been restored. You can now access all platform features.',
                timestamp: new Date().toISOString()
            };

            const { unreadCount } =
                await notificationService.createNotificationWithCount(
                    userId,
                    'ACCOUNT_ACTIVATED',
                    payload
                );

            await notificationDelivery.deliverToUser(
                userId,
                'ACCOUNT_ACTIVATED',
                payload,
                unreadCount
            );

            logger.info(`Account activated notification sent to ${role} user ${userId}`);
        } catch (error) {
            logger.error('Error emitting account activated notification:', error);
        }
    }
}

module.exports = new NotificationEmitter();
