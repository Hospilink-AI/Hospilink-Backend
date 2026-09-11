const notificationService = require('./notificationService');
const websocketManager = require('./websocketManager');
const notificationDelivery = require('./notificationDelivery.service');
const geocodingService = require('./geocoding.service');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const User = require('../models/User');
const JobVacancy = require('../models/JobVacancy');



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
     * Notify staff that a new End OTP has been generated for their duty and sent via SMS
     * @param {Object} duty - Duty object
     * @param {string} staffUserId - Staff user ID
     * @param {Date} expiresAt - OTP expiry timestamp
     */
    async emitEndOtpRegenerated(duty, staffUserId, expiresAt) {
        try {
            if (!duty || !staffUserId) {
                console.error('Missing required parameters for emitEndOtpRegenerated');
                return;
            }

            const dutyIdShort = duty._id.toString().slice(-6);

            const payload = {
                type: 'END_OTP_REGENERATED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime
                },
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                message: `A new end OTP for duty #${dutyIdShort} has been sent to your registered mobile number via SMS. Share it with the hospital to mark the duty complete.`,
                timestamp: new Date().toISOString()
            };

            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    staffUserId,
                    'END_OTP_REGENERATED',
                    payload
                );

                await notificationDelivery.deliverToUser(staffUserId, 'END_OTP_REGENERATED', payload, unreadCount);

                console.log(`End OTP regenerated notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending end OTP regenerated notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting end OTP regenerated notification:', error);
        }
    }

    /**
     * Notify both hospital and staff that a duty has moved to pending-confirmation
     * (hospital did not verify the end OTP within the grace period after duty end time)
     * @param {Object} duty - Duty object
     * @param {Object} staff - Medical staff object (populated with user)
     * @param {string} hospitalUserId - Hospital user ID
     * @param {string} staffUserId - Staff user ID
     */
    async emitDutyPendingConfirmation(duty, staff, hospitalUserId, staffUserId) {
        try {
            if (!duty || !staff || !hospitalUserId || !staffUserId) {
                console.error('Missing required parameters for emitDutyPendingConfirmation');
                return;
            }

            const staffName = staff.fullName || staff.user?.name || 'Staff Member';
            const dutyIdShort = duty._id.toString().slice(-6);

            const basePayload = {
                type: 'DUTY_PENDING_CONFIRMATION',
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
                timestamp: new Date().toISOString()
            };

            // Notify hospital — please confirm the end OTP
            try {
                const hospitalPayload = {
                    ...basePayload,
                    message: `Duty #${dutyIdShort} has ended but is awaiting your confirmation. Please verify the end OTP from ${staffName} to mark it as completed.`
                };

                const { unreadCount } = await notificationService.createNotificationWithCount(
                    hospitalUserId,
                    'DUTY_PENDING_CONFIRMATION',
                    hospitalPayload
                );

                await notificationDelivery.deliverToUser(hospitalUserId, 'DUTY_PENDING_CONFIRMATION', hospitalPayload, unreadCount);

                console.log(`Pending-confirmation notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending pending-confirmation notification to hospital ${hospitalUserId}:`, error);
            }

            // Notify staff — they're free to accept new duties
            try {
                const staffPayload = {
                    ...basePayload,
                    message: `Duty #${dutyIdShort} is now pending hospital confirmation. You're free to accept new duties.`
                };

                const { unreadCount } = await notificationService.createNotificationWithCount(
                    staffUserId,
                    'DUTY_PENDING_CONFIRMATION',
                    staffPayload
                );

                await notificationDelivery.deliverToUser(staffUserId, 'DUTY_PENDING_CONFIRMATION', staffPayload, unreadCount);

                console.log(`Pending-confirmation notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending pending-confirmation notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting duty pending-confirmation notification:', error);
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
                    ? `You received a ${rating}⭐ review: "${reviewText}"`: `You received a ${rating}⭐ rating from hospital`,
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
     * Prompt staff to rate the hospital after a duty is marked completed
     * @param {Object} duty - Duty object
     * @param {Object} hospital - Hospital object
     * @param {string} staffUserId - Staff user ID
     */
    async emitRateHospitalPrompt(duty, hospital, staffUserId) {
        try {
            if (!duty || !hospital || !staffUserId) {
                console.error('Missing required parameters for emitRateHospitalPrompt');
                return;
            }

            const hospitalName = hospital.hospitalLegalName || hospital.user?.name || 'the hospital';
            const dutyIdShort = duty._id.toString().slice(-6);

            const payload = {
                type: 'RATE_HOSPITAL_PROMPT',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime
                },
                hospital: {
                    id: hospital._id.toString(),
                    name: hospitalName
                },
                message: `Duty #${dutyIdShort} at ${hospitalName} has been completed. Please rate your experience.`,
                completedAt: new Date().toISOString(),
                timestamp: new Date().toISOString()
            };

            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    staffUserId,
                    'RATE_HOSPITAL_PROMPT',
                    payload
                );

                await notificationDelivery.deliverToUser(staffUserId, 'RATE_HOSPITAL_PROMPT', payload, unreadCount);

                console.log(`Rate-hospital prompt sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending rate-hospital prompt to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting rate-hospital prompt:', error);
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

    // Resume-driven onboarding — tells a staff member which profile fields were
    // auto-filled from their uploaded resume, so they know to review it.
    async emitProfileAutoFilledFromResume(userId, filledFields = []) {
        try {
            if (!userId) {
                console.error('Missing required parameters for emitProfileAutoFilledFromResume');
                return;
            }

            const fieldList = filledFields.length ? filledFields.join(', ') : 'basic info';

            const payload = {
                type: 'PROFILE_AUTO_FILLED_FROM_RESUME',
                filledFields,
                message: `We filled in your profile from your resume (${fieldList}). Review it any time.`,
                timestamp: new Date().toISOString()
            };

            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    userId,
                    'PROFILE_AUTO_FILLED_FROM_RESUME',
                    payload
                );

                await notificationDelivery.deliverToUser(userId, 'PROFILE_AUTO_FILLED_FROM_RESUME', payload, unreadCount);

                console.log(`Profile auto-fill notification sent to staff ${userId}`);
            } catch (error) {
                console.error(`Error sending profile auto-fill notification to staff ${userId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting profile auto-fill notification:', error);
        }
    }

    // Resume analysis (score + suggestions) — fired every time a resume is
    // parsed, on both onboarding paths, whether this is the first resume ever
    // uploaded or a replacement for a previous one. Independent of
    // emitProfileAutoFilledFromResume, which only fires when a brand-new
    // profile was created.
    async emitResumeAnalyzed(userId, { total } = {}, suggestions = [], isReanalysis = false) {
        try {
            if (!userId) {
                console.error('Missing required parameters for emitResumeAnalyzed');
                return;
            }

            const message = isReanalysis
                ? `Your resume has been re-analyzed — new score: ${total}/100.`
                : `Your resume scored ${total}/100.`;

            const payload = {
                type: 'RESUME_ANALYZED',
                score: total,
                suggestions,
                isReanalysis,
                message,
                timestamp: new Date().toISOString()
            };

            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(
                    userId,
                    'RESUME_ANALYZED',
                    payload
                );

                await notificationDelivery.deliverToUser(userId, 'RESUME_ANALYZED', payload, unreadCount);

                console.log(`Resume analyzed notification sent to staff ${userId}`);
            } catch (error) {
                console.error(`Error sending resume analyzed notification to staff ${userId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting resume analyzed notification:', error);
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

    // ─── Account suspension notifications ─────────────────────────────────────

    /**
     * Emit account suspended notification to the affected user
     * @param {Object} profile - Hospital or MedicalStaff object
     * @param {string} userId - User ID string
     * @param {string} role - 'hospital' | 'staff'
     * @param {string} reason - Suspension reason
     */
    async emitAccountSuspended(profile, userId, role, reason) {
        try {
            const name = role === 'hospital'
                ? (profile.hospitalLegalName || 'Account')
                : (profile.fullName || 'Account');

            const payload = {
                type: 'ACCOUNT_SUSPENDED',
                reason,
                message: `Your account has been suspended. Reason: ${reason}. Please contact support for assistance.`,
                timestamp: new Date().toISOString()
            };

            const { unreadCount } = await notificationService.createNotificationWithCount(
                userId, 'ACCOUNT_SUSPENDED', payload
            );
            await notificationDelivery.deliverToUser(userId, 'ACCOUNT_SUSPENDED', payload, unreadCount);
            console.log(`[NOTIFICATION] Account suspended notification sent to ${role} user ${userId}`);
        } catch (error) {
            console.error('[NOTIFICATION] Error emitting account suspended notification:', error);
        }
    }

    /**
     * Emit account activated (unsuspended) notification to the affected user
     * @param {Object} profile - Hospital or MedicalStaff object
     * @param {string} userId - User ID string
     * @param {string} role - 'hospital' | 'staff'
     */
    async emitAccountActivated(profile, userId, role) {
        try {
            const payload = {
                type: 'ACCOUNT_ACTIVATED',
                message: 'Your account has been restored. You can now access all platform features.',
                timestamp: new Date().toISOString()
            };

            const { unreadCount } = await notificationService.createNotificationWithCount(
                userId, 'ACCOUNT_ACTIVATED', payload
            );
            await notificationDelivery.deliverToUser(userId, 'ACCOUNT_ACTIVATED', payload, unreadCount);
            console.log(`[NOTIFICATION] Account activated notification sent to ${role} user ${userId}`);
        } catch (error) {
            console.error('[NOTIFICATION] Error emitting account activated notification:', error);
        }
    }

    // ─── Job application — apply / review pipeline ──────────────────────────

    // Internal helper — resolves a hospital's own login user id from a
    // hospitalId, used by every hospital-facing job-application emitter below
    // so callers only ever need to pass the application/vacancy object, not
    // a pre-resolved user id.
    async _resolveHospitalUserId(hospitalId) {
        const hospital = await Hospital.findById(hospitalId).select('user hospitalLegalName').lean();
        return hospital ? { userId: hospital.user, name: hospital.hospitalLegalName } : null;
    }

    async _vacancyTitle(vacancyId) {
        const vacancy = await JobVacancy.findById(vacancyId).select('title').lean();
        return vacancy?.title || 'the role';
    }

    async emitProfileRequiredForApplication(userId, vacancy) {
        try {
            const payload = {
                type: 'PROFILE_REQUIRED_FOR_APPLICATION',
                vacancy: { id: vacancy._id, title: vacancy.title },
                message: 'Complete your profile before applying for a permanent job. You can apply using just your resume.',
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                userId, 'PROFILE_REQUIRED_FOR_APPLICATION', payload
            );
            await notificationDelivery.deliverToUser(userId, 'PROFILE_REQUIRED_FOR_APPLICATION', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting profile-required-for-application notification:', error);
        }
    }

    async emitResumeRequiredForApplication(userId, vacancy) {
        try {
            const payload = {
                type: 'RESUME_REQUIRED_FOR_APPLICATION',
                vacancy: { id: vacancy._id, title: vacancy.title },
                message: 'Upload your resume to apply for permanent job openings.',
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                userId, 'RESUME_REQUIRED_FOR_APPLICATION', payload
            );
            await notificationDelivery.deliverToUser(userId, 'RESUME_REQUIRED_FOR_APPLICATION', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting resume-required-for-application notification:', error);
        }
    }

    async emitNewJobApplication(vacancy, application, applicantName) {
        try {
            const hospital = await this._resolveHospitalUserId(vacancy.hospitalId);
            if (!hospital) return;

            const payload = {
                type: 'NEW_JOB_APPLICATION',
                application: { id: application._id },
                vacancy: { id: vacancy._id, title: vacancy.title },
                applicantName,
                message: `${applicantName} applied for ${vacancy.title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                hospital.userId, 'NEW_JOB_APPLICATION', payload
            );
            await notificationDelivery.deliverToUser(hospital.userId, 'NEW_JOB_APPLICATION', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting new-job-application notification:', error);
        }
    }

    async emitApplicationShortlisted(application) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'APPLICATION_SHORTLISTED',
                application: { id: application._id },
                message: `You've been shortlisted for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                application.user, 'APPLICATION_SHORTLISTED', payload
            );
            await notificationDelivery.deliverToUser(application.user, 'APPLICATION_SHORTLISTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting application-shortlisted notification:', error);
        }
    }

    async emitApplicationRejected(application, reason, reasonText) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'APPLICATION_REJECTED',
                application: { id: application._id },
                reason,
                reasonText: reasonText || null,
                message: `Your application for ${title} was not selected to move forward.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                application.user, 'APPLICATION_REJECTED', payload
            );
            await notificationDelivery.deliverToUser(application.user, 'APPLICATION_REJECTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting application-rejected notification:', error);
        }
    }

    async emitApplicationWithdrawn(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;

            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'APPLICATION_WITHDRAWN',
                application: { id: application._id },
                message: `A candidate withdrew their application for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(
                hospital.userId, 'APPLICATION_WITHDRAWN', payload
            );
            await notificationDelivery.deliverToUser(hospital.userId, 'APPLICATION_WITHDRAWN', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting application-withdrawn notification:', error);
        }
    }

    // ─── Job application — interview scheduling ─────────────────────────────
    // No notification below ever includes the raw meeting URL — every one
    // deep-links into the application detail screen instead (§08 of the
    // build spec: "the exposure is real and this is what limits it").

    async emitSlotsOffered(application) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'SLOTS_OFFERED',
                application: { id: application._id },
                expiresAt: application.interview.offer.expiresAt,
                message: `${title}: pick a time that works for your interview. Offer expires ${new Date(application.interview.offer.expiresAt).toLocaleDateString('en-IN')}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'SLOTS_OFFERED', payload);
            await notificationDelivery.deliverToUser(application.user, 'SLOTS_OFFERED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting slots-offered notification:', error);
        }
    }

    async emitCandidatePickedSlots(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'CANDIDATE_PICKED_SLOTS',
                application: { id: application._id },
                picks: application.interview.candidatePicks,
                message: `A candidate picked interview slots for ${title}. Confirm one to book the interview.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'CANDIDATE_PICKED_SLOTS', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'CANDIDATE_PICKED_SLOTS', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting candidate-picked-slots notification:', error);
        }
    }

    async emitInterviewConfirmed(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'INTERVIEW_CONFIRMED',
                application: { id: application._id },
                slot: application.interview.confirmedSlot,
                interviewerName: application.interview.interviewerName,
                message: `Interview confirmed for ${title}. Open the app for the time, interviewer and join link.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount: staffUnread } = await notificationService.createNotificationWithCount(application.user, 'INTERVIEW_CONFIRMED', payload);
            await notificationDelivery.deliverToUser(application.user, 'INTERVIEW_CONFIRMED', payload, staffUnread);
            if (hospital) {
                const { unreadCount: hospitalUnread } = await notificationService.createNotificationWithCount(hospital.userId, 'INTERVIEW_CONFIRMED', payload);
                await notificationDelivery.deliverToUser(hospital.userId, 'INTERVIEW_CONFIRMED', payload, hospitalUnread);
            }
        } catch (error) {
            console.error('Error emitting interview-confirmed notification:', error);
        }
    }

    // cancelledByRole is who TOOK the action ('hospital' | 'staff') — notifies
    // the other side.
    async emitInterviewCancelled(application, cancelledByRole, reason, reasonText) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'INTERVIEW_CANCELLED',
                application: { id: application._id },
                reason,
                reasonText: reasonText || null,
                message: `Your interview for ${title} was cancelled. Reason: ${reason}.`,
                timestamp: new Date().toISOString()
            };

            if (cancelledByRole === 'hospital') {
                const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'INTERVIEW_CANCELLED', payload);
                await notificationDelivery.deliverToUser(application.user, 'INTERVIEW_CANCELLED', payload, unreadCount);
            } else {
                const hospital = await this._resolveHospitalUserId(application.hospitalId);
                if (!hospital) return;
                const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'INTERVIEW_CANCELLED', payload);
                await notificationDelivery.deliverToUser(hospital.userId, 'INTERVIEW_CANCELLED', payload, unreadCount);
            }
        } catch (error) {
            console.error('Error emitting interview-cancelled notification:', error);
        }
    }

    async emitInterviewRescheduled(application) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'INTERVIEW_RESCHEDULED',
                application: { id: application._id },
                message: `Your interview for ${title} was rescheduled — new times are ready to pick in the app.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'INTERVIEW_RESCHEDULED', payload);
            await notificationDelivery.deliverToUser(application.user, 'INTERVIEW_RESCHEDULED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting interview-rescheduled notification:', error);
        }
    }

    async emitRescheduleRequested(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'RESCHEDULE_REQUESTED',
                application: { id: application._id },
                reason: application.interview.rescheduleRequest?.reason,
                message: `A candidate requested a reschedule for their interview for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'RESCHEDULE_REQUESTED', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'RESCHEDULE_REQUESTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting reschedule-requested notification:', error);
        }
    }

    async emitMeetingLinkChanged(application) {
        try {
            const payload = {
                type: 'MEETING_LINK_CHANGED',
                application: { id: application._id },
                message: 'The meeting link for your interview was updated. Open the app to see the new link.',
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'MEETING_LINK_CHANGED', payload);
            await notificationDelivery.deliverToUser(application.user, 'MEETING_LINK_CHANGED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting meeting-link-changed notification:', error);
        }
    }

    async emitJobOfferExtended(application) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'JOB_OFFER_EXTENDED',
                application: { id: application._id },
                message: `You've been offered the role for ${title}. Open the app to respond.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'JOB_OFFER_EXTENDED', payload);
            await notificationDelivery.deliverToUser(application.user, 'JOB_OFFER_EXTENDED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting job-offer-extended notification:', error);
        }
    }

    async emitMarkedNoShow(application) {
        try {
            const payload = {
                type: 'MARKED_NO_SHOW',
                application: { id: application._id },
                message: 'You were marked as a no-show for your interview. You have 7 days to dispute this if you believe it is wrong.',
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'MARKED_NO_SHOW', payload);
            await notificationDelivery.deliverToUser(application.user, 'MARKED_NO_SHOW', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting marked-no-show notification:', error);
        }
    }

    async emitHospitalNoShowReported(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'HOSPITAL_NO_SHOW_REPORTED',
                application: { id: application._id },
                message: `A candidate reported nobody joined their interview for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'HOSPITAL_NO_SHOW_REPORTED', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'HOSPITAL_NO_SHOW_REPORTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting hospital-no-show-reported notification:', error);
        }
    }

    async emitApplicationHired(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const title = await this._vacancyTitle(application.vacancy);
            const payload = {
                type: 'APPLICATION_HIRED',
                application: { id: application._id },
                message: `A candidate accepted your job offer for ${title}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'APPLICATION_HIRED', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'APPLICATION_HIRED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting application-hired notification:', error);
        }
    }

    async emitContactDetailsReleased(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const hospitalName = hospital?.name || 'the hospital';
            const payload = {
                type: 'CONTACT_DETAILS_RELEASED',
                application: { id: application._id },
                hospitalName,
                message: `Your phone and email have been shared with ${hospitalName}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'CONTACT_DETAILS_RELEASED', payload);
            await notificationDelivery.deliverToUser(application.user, 'CONTACT_DETAILS_RELEASED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting contact-details-released notification:', error);
        }
    }

    async emitInterviewReminder(application, windowLabel) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const title = await this._vacancyTitle(application.vacancy);
            const type = windowLabel === '24h' ? 'INTERVIEW_REMINDER_24H' : 'INTERVIEW_REMINDER_1H';
            const payload = {
                type,
                application: { id: application._id },
                slot: application.interview.confirmedSlot,
                message: `Reminder: your interview for ${title} is ${windowLabel === '24h' ? 'tomorrow' : 'in about an hour'}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount: staffUnread } = await notificationService.createNotificationWithCount(application.user, type, payload);
            await notificationDelivery.deliverToUser(application.user, type, payload, staffUnread);
            if (hospital) {
                const { unreadCount: hospitalUnread } = await notificationService.createNotificationWithCount(hospital.userId, type, payload);
                await notificationDelivery.deliverToUser(hospital.userId, type, payload, hospitalUnread);
            }
        } catch (error) {
            console.error('Error emitting interview-reminder notification:', error);
        }
    }

    async emitOfferUnansweredReminder(application, dayLabel) {
        try {
            const title = await this._vacancyTitle(application.vacancy);
            const nearingExpiry = dayLabel === 'day18';
            const payload = {
                type: 'OFFER_UNANSWERED_REMINDER',
                application: { id: application._id },
                message: nearingExpiry
                    ? `Your interview slot offer for ${title} lapses in 3 days — pick a time before it expires.`
                    : `You have interview slots waiting for ${title}. Pick a time that works for you.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(application.user, 'OFFER_UNANSWERED_REMINDER', payload);
            await notificationDelivery.deliverToUser(application.user, 'OFFER_UNANSWERED_REMINDER', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting offer-unanswered-reminder notification:', error);
        }
    }

    async emitConfirmationPendingReminder(application, dayLabel) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            if (!hospital) return;
            const earliestPick = (application.interview.candidatePicks || [])
                .slice().sort((a, b) => new Date(a.start) - new Date(b.start))[0];
            const payload = {
                type: 'CONFIRMATION_PENDING_REMINDER',
                application: { id: application._id },
                earliestPick,
                message: `A candidate is still waiting on interview confirmation${dayLabel === 'day18' ? ' — this lapses in 3 days' : ''}.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospital.userId, 'CONFIRMATION_PENDING_REMINDER', payload);
            await notificationDelivery.deliverToUser(hospital.userId, 'CONFIRMATION_PENDING_REMINDER', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting confirmation-pending-reminder notification:', error);
        }
    }

    async emitOfferExpired(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const title = await this._vacancyTitle(application.vacancy);
            const staffPayload = {
                type: 'OFFER_EXPIRED',
                application: { id: application._id },
                message: `Your interview slot offer for ${title} lapsed. The role may still be open — check back or wait for a new offer.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount: staffUnread } = await notificationService.createNotificationWithCount(application.user, 'OFFER_EXPIRED', staffPayload);
            await notificationDelivery.deliverToUser(application.user, 'OFFER_EXPIRED', staffPayload, staffUnread);

            if (hospital) {
                const hospitalPayload = {
                    ...staffPayload,
                    message: `An interview slot offer for ${title} lapsed because the candidate never picked a time.`
                };
                const { unreadCount: hospitalUnread } = await notificationService.createNotificationWithCount(hospital.userId, 'OFFER_EXPIRED', hospitalPayload);
                await notificationDelivery.deliverToUser(hospital.userId, 'OFFER_EXPIRED', hospitalPayload, hospitalUnread);
            }
        } catch (error) {
            console.error('Error emitting offer-expired notification:', error);
        }
    }

    async emitSelectionExpired(application) {
        try {
            const hospital = await this._resolveHospitalUserId(application.hospitalId);
            const title = await this._vacancyTitle(application.vacancy);
            const staffPayload = {
                type: 'SELECTION_EXPIRED',
                application: { id: application._id },
                message: `The hospital did not confirm your interview for ${title} in time. No interview is scheduled, but the role may still be open.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount: staffUnread } = await notificationService.createNotificationWithCount(application.user, 'SELECTION_EXPIRED', staffPayload);
            await notificationDelivery.deliverToUser(application.user, 'SELECTION_EXPIRED', staffPayload, staffUnread);

            if (hospital) {
                const hospitalPayload = {
                    ...staffPayload,
                    message: `A picked interview slot for ${title} expired unconfirmed. This counts as a lapsed offer.`
                };
                const { unreadCount: hospitalUnread } = await notificationService.createNotificationWithCount(hospital.userId, 'SELECTION_EXPIRED', hospitalPayload);
                await notificationDelivery.deliverToUser(hospital.userId, 'SELECTION_EXPIRED', hospitalPayload, hospitalUnread);
            }
        } catch (error) {
            console.error('Error emitting selection-expired notification:', error);
        }
    }

    async emitHireCloseoutPrompt(hospitalUserId, vacancyTitle, openCount) {
        try {
            const payload = {
                type: 'HIRE_CLOSEOUT_PROMPT',
                vacancyTitle,
                openCount,
                message: `${vacancyTitle} has a hire recorded and ${openCount} other application(s) still open. Close them out when you're ready.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(hospitalUserId, 'HIRE_CLOSEOUT_PROMPT', payload);
            await notificationDelivery.deliverToUser(hospitalUserId, 'HIRE_CLOSEOUT_PROMPT', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting hire-closeout-prompt notification:', error);
        }
    }

    // ─── Disputes & Support ──────────────────────────────────────────────

    // spec §13's first notification row: raiser gets the ticket ID and the
    // published SLA date — deliberately no minute-level ETA.
    async emitTicketCreated(ticket) {
        try {
            const payload = {
                type: 'TICKET_CREATED',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: `Your ticket ${ticket.ticketId} has been received. We'll get back to you by ${new Date(ticket.slaDecideBy).toLocaleDateString()}.`,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_CREATED', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_CREATED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting ticket-created notification:', error);
        }
    }

    // spec §13: "Recategorised → Raiser, only where it changes what happens
    // next" — the caller (ticket.service#recategorize) only invokes this
    // when the route/class actually differs from before.
    async emitTicketRecategorized(ticket, oldCategory) {
        try {
            const payload = {
                type: 'TICKET_RECATEGORIZED',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                oldCategory,
                newCategory: ticket.category,
                message: `Your ticket ${ticket.ticketId} was recategorised, which may change who handles it and when you'll hear back.`,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_RECATEGORIZED', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_RECATEGORIZED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting ticket-recategorized notification:', error);
        }
    }

    // spec §08.01/§13 — fires immediately at creation for ADJUDICATED
    // tickets, independent of any agent claiming it. Deliberately never
    // includes the raiser's exact words or contact details — only the
    // category and the deadline.
    async emitClaimExists(ticket) {
        try {
            const isLive = ticket.respondentDeadline &&
                (ticket.respondentDeadline.getTime() - ticket.respondentNotifiedAt.getTime()) <= 2 * 60 * 60 * 1000;
            const payload = {
                type: 'TICKET_CLAIM_EXISTS',
                ticket: { id: ticket._id, ticketId: ticket.ticketId, category: ticket.category },
                message: isLive
                    ? `A claim has been raised regarding ${ticket.category.replace('.', ' — ')}. Because this concerns a shift happening now, please respond within 2 hours.`
                    : `A claim has been raised regarding ${ticket.category.replace('.', ' — ')}. You have until ${new Date(ticket.respondentDeadline).toLocaleString()} to respond.`,
                respondentDeadline: ticket.respondentDeadline,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedAgainst.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_CLAIM_EXISTS', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_CLAIM_EXISTS', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting claim-exists notification:', error);
        }
    }

    // spec §13 — "Response window closing → Respondent, at half the window
    // and again at two hours remaining."
    async emitResponseWindowClosing(ticket, label) {
        try {
            const payload = {
                type: 'TICKET_RESPONSE_WINDOW_CLOSING',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: `You have ${label} left to respond to the claim on ticket ${ticket.ticketId}.`,
                respondentDeadline: ticket.respondentDeadline,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedAgainst.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_RESPONSE_WINDOW_CLOSING', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_RESPONSE_WINDOW_CLOSING', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting response-window-closing notification:', error);
        }
    }

    // spec §13: "Outcome decided → Both parties, the action-taken
    // statement, in the recipient's language." Same statement to both
    // sides — only the notification's framing differs by recipient role.
    async emitTicketOutcomeDecided(ticket) {
        try {
            const recipients = [ticket.raisedBy.user];
            if (ticket.raisedAgainst?.user) recipients.push(ticket.raisedAgainst.user);

            await Promise.all(recipients.map(async (recipient) => {
                const payload = {
                    type: 'TICKET_OUTCOME_DECIDED',
                    ticket: { id: ticket._id, ticketId: ticket.ticketId },
                    resolutionOutcome: ticket.resolutionOutcome,
                    statement: ticket.actionTakenStatement,
                    message: ticket.actionTakenStatement,
                    timestamp: new Date().toISOString()
                };
                const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_OUTCOME_DECIDED', payload);
                await notificationDelivery.deliverToUser(recipient, 'TICKET_OUTCOME_DECIDED', payload, unreadCount);
            }));
        } catch (error) {
            console.error('Error emitting ticket-outcome-decided notification:', error);
        }
    }

    // Day 2 spec update — an admin asked the raiser for more detail before
    // going further. Mirrors emitClaimExists's shape, but to the raiser
    // instead of the respondent, and with the admin's actual question
    // rather than a fixed category-based message.
    async emitInfoRequested(ticket, message) {
        try {
            const payload = {
                type: 'TICKET_INFO_REQUESTED',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: `More information is needed on your ticket ${ticket.ticketId}: ${message}`,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_INFO_REQUESTED', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_INFO_REQUESTED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting info-requested notification:', error);
        }
    }

    // Day 2 spec update — day-1/day-3 nudges while a ticket sits in
    // AWAITING_RAISER, ahead of the 5-day auto-close. Mirrors
    // emitResponseWindowClosing exactly, just to the raiser.
    async emitInfoRequestReminder(ticket, label) {
        try {
            const payload = {
                type: 'TICKET_INFO_REQUEST_REMINDER',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: `We still need more information on your ticket ${ticket.ticketId} (asked ${label}). Reply soon or it will be automatically closed.`,
                timestamp: new Date().toISOString()
            };
            const recipient = ticket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_INFO_REQUEST_REMINDER', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_INFO_REQUEST_REMINDER', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting info-request-reminder notification:', error);
        }
    }

    // Day 3 spec update — a chat message on a ticket, pushed to whichever
    // side didn't send it. Reuses the exact same online/offline routing
    // every other ticket notification already goes through
    // (notificationDelivery.deliverToUser), which is what "reusing existing
    // Socket.IO infrastructure" means here — no bespoke push path.
    async emitChatMessage(ticket, recipientUserId, { text, hasFiles, senderDisplay }) {
        try {
            const preview = text
                ? (text.length > 80 ? `${text.slice(0, 80)}…` : text)
                : (hasFiles ? 'Sent a file' : '');
            const payload = {
                type: 'TICKET_CHAT_MESSAGE',
                ticket: { id: ticket._id, ticketId: ticket.ticketId },
                message: senderDisplay
                    ? `New message from ${senderDisplay} on ticket ${ticket.ticketId}: ${preview}`
                    : `New message on ticket ${ticket.ticketId}: ${preview}`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(recipientUserId, 'TICKET_CHAT_MESSAGE', payload);
            await notificationDelivery.deliverToUser(recipientUserId, 'TICKET_CHAT_MESSAGE', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting chat-message notification:', error);
        }
    }

    // spec §13: "Appeal outcome → Appellant, Fresh statement." Only the
    // appellant — the appeal's respondent already gets the standard
    // TICKET_OUTCOME_DECIDED notification when the appeal ticket resolves.
    async emitAppealOutcome(appealTicket) {
        try {
            const payload = {
                type: 'TICKET_APPEAL_OUTCOME',
                ticket: { id: appealTicket._id, ticketId: appealTicket.ticketId },
                appealOf: appealTicket.appealOf,
                resolutionOutcome: appealTicket.resolutionOutcome,
                statement: appealTicket.actionTakenStatement,
                message: appealTicket.actionTakenStatement,
                timestamp: new Date().toISOString()
            };
            const recipient = appealTicket.raisedBy.user;
            const { unreadCount } = await notificationService.createNotificationWithCount(recipient, 'TICKET_APPEAL_OUTCOME', payload);
            await notificationDelivery.deliverToUser(recipient, 'TICKET_APPEAL_OUTCOME', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting appeal-outcome notification:', error);
        }
    }

    // ─── Patterns & Suspension ──────────────────────────────────────────────

    // spec §13: "Pattern flag raised → Flagged party, the specific cases
    // relied on." Never a shadow record (§10.04).
    async emitPatternFlagRaised(flag) {
        try {
            const payload = {
                type: 'PATTERN_FLAG_RAISED',
                flag: { id: flag._id, patternType: flag.patternType },
                casesRelied: flag.casesRelied,
                message: `A pattern has been flagged on your account (${flag.patternType.replace(/_/g, ' ')}), based on ${flag.casesRelied.length} case(s). You can review the specific cases in your account.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(flag.party, 'PATTERN_FLAG_RAISED', payload);
            await notificationDelivery.deliverToUser(flag.party, 'PATTERN_FLAG_RAISED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting pattern-flag-raised notification:', error);
        }
    }

    // spec §13: "Suspension proposed → Proposed party, reasons, the 14-day
    // window, and how to respond."
    async emitSuspensionProposed(flag) {
        try {
            const payload = {
                type: 'SUSPENSION_PROPOSED',
                flag: { id: flag._id, patternType: flag.patternType },
                casesRelied: flag.casesRelied,
                responseDeadline: flag.proposal?.responseDeadline,
                message: `A suspension has been proposed on your account based on ${flag.casesRelied.length} case(s). You have until ${new Date(flag.proposal?.responseDeadline).toLocaleDateString()} to respond.`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(flag.party, 'SUSPENSION_PROPOSED', payload);
            await notificationDelivery.deliverToUser(flag.party, 'SUSPENSION_PROPOSED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting suspension-proposed notification:', error);
        }
    }

    async emitSuspensionDecided(flag) {
        try {
            const payload = {
                type: 'SUSPENSION_DECIDED',
                flag: { id: flag._id, patternType: flag.patternType },
                decision: flag.proposal?.decision,
                decisionReason: flag.proposal?.decisionReason,
                message: flag.proposal?.decision === 'suspend'
                    ? `Your account has been suspended. Reason: ${flag.proposal.decisionReason}`
                    : `The proposed suspension on your account was not upheld. Reason: ${flag.proposal?.decisionReason || ''}`,
                timestamp: new Date().toISOString()
            };
            const { unreadCount } = await notificationService.createNotificationWithCount(flag.party, 'SUSPENSION_DECIDED', payload);
            await notificationDelivery.deliverToUser(flag.party, 'SUSPENSION_DECIDED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting suspension-decided notification:', error);
        }
    }
}

module.exports = new NotificationEmitter();
