// Notifications: duty lifecycle (posted, offered, accepted, en route, on site, started, completed, cancelled, relisted) and duty alerts
// Methods of NotificationEmitter; mixed into the class in ../notificationEmitter.js, so `this` is the service.
const logger = require('../../utils/logger');
const notificationService = require('../notificationService');
const websocketManager = require('../websocketManager');
const notificationDelivery = require('../notificationDelivery.service');
const geocodingService = require('../geocoding.service');
const Hospital = require('../../models/Hospital');
const User = require('../../models/User');

module.exports = {
    /**
     * Emit duty created notification to matching staff AND hospital
     * @param {Object} duty - Duty object
     * @param {Object} hospital - Hospital object
     * @param {string[]} matchingStaffUserIds - Array of user IDs for matching staff
     * @param {string} hospitalUserId - Hospital user ID
     * @param {Object} [batch] - { count, dutyIds } when several slots were posted at once
     */
    async emitDutyCreated(duty, hospital, matchingStaffUserIds, hospitalUserId, batch = null) {
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
                hospitalMessage = batch
                    ? `Your emergency request for ${batch.count} ${duty.staffRole} has been broadcast to ${staffCount} available staff within radius.`
                    : `Your emergency request for ${duty.staffRole} has been broadcast to ${staffCount} available staff within radius.`;
            } else {
                hospitalMessage = batch
                    ? `${batch.count} duties created successfully for ${duty.staffRole}`
                    : `Duty created successfully for ${duty.staffRole}`;
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
                ...(batch && { count: batch.count, dutyIds: batch.dutyIds }),
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
                        message = batch
                            ? `EMERGENCY: ${batch.count} ${duty.staffRole} required immediately at ${hospitalName} — ${hospitalLocation}. Critical response needed. Tap to accept.`
                            : `EMERGENCY: Immediate ${duty.staffRole} required at ${hospitalName} — ${hospitalLocation}. Critical response needed. Tap to accept.`;
                    } else {
                        message = batch
                            ? `${batch.count} duties available near you — ${duty.staffRole} at ${hospitalName}, ${dutyDate} ${dutyTime}. Tap to accept.`
                            : `New duty available near you — ${duty.staffRole} at ${hospitalName}, ${dutyDate} ${dutyTime}. Tap to accept.`;
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
                        ...(batch && { count: batch.count, dutyIds: batch.dutyIds }),
                        message: message,
                        timestamp: new Date().toISOString()
                    };

                    // Persist notifications in bulk for all matching staff
                    await notificationService.createBulkNotifications(matchingStaffUserIds, notificationType, staffPayload);
                    
                    // Broadcast to role room for real-time notification (online staff)
                    // Staged offers reach only the doctors they are offered to
                    if (!duty.offer?.mode && !duty.isDemo) websocketManager.emitToStaffRole(duty.staffRole, 'notification', staffPayload);

                    // Phase 3: Smart delivery - WebSocket (online) + FCM (offline)
                    const delivery = await notificationDelivery.deliverToUsers(matchingStaffUserIds, notificationType, staffPayload);

                    // Phase 2: Mark notifications as delivered for online staff
                    const onlineStaffIds = delivery.onlineIds || [];
                    
                    if (onlineStaffIds.length > 0) {
                        await notificationService.markDeliveredForUsers(
                            onlineStaffIds, 
                            notificationType, 
                            duty._id.toString()
                        );
                        logger.debug(`Marked ${onlineStaffIds.length}/${matchingStaffUserIds.length} staff notifications as delivered (online)`);
                    }

                    const notificationTypeLabel = isEmergency ? 'EMERGENCY_DUTY_REQUEST' : 'NEW_DUTY_OFFER';
                    logger.debug(`Duty created notification emitted to hospital and ${matchingStaffUserIds.length} staff members via role room (${notificationTypeLabel})`);
                } catch (error) {
                    console.error('Error creating staff notifications:', error);
                }
            }
        } catch (error) {
            console.error('Error emitting duty created notification:', error);
        }
    },

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
                logger.debug(`Staff assigned notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending staff assigned notification to hospital ${hospitalUserId}:`, error);
            }

            // Persist notification for staff (isolated try-catch)
            try {
                logger.debug(`Attempting to send DUTY_CONFIRMED to staff ${staffUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(staffUserId, 'DUTY_CONFIRMED', staffPayload);
                logger.debug(`DUTY_CONFIRMED notification created in DB for staff ${staffUserId}, unread count: ${unreadCount}`);
                await notificationDelivery.deliverToUser(staffUserId, 'DUTY_CONFIRMED', staffPayload, unreadCount);
                logger.debug(`Duty confirmed notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending duty confirmed notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting duty accepted notification:', error);
        }
    },

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
                
                logger.debug(`Staff en route notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending staff en route notification to hospital ${hospitalUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting staff en route notification:', error);
        }
    },

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
                
                logger.debug(`Staff on-site notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending staff on-site notification to hospital ${hospitalUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting staff on-site notification:', error);
        }
    },

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

                logger.debug(`End OTP regenerated notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending end OTP regenerated notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting end OTP regenerated notification:', error);
        }
    },

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

                logger.debug(`Pending-confirmation notification sent to hospital ${hospitalUserId}`);
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

                logger.debug(`Pending-confirmation notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending pending-confirmation notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting duty pending-confirmation notification:', error);
        }
    },

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
                
                logger.debug(`Navigate to duty notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending navigate to duty notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting navigate to duty notification:', error);
        }
    },

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
                    
                    logger.debug(`Duty cancelled notification (${notificationType}) sent to user ${recipientUserId}`);
                } catch (error) {
                    console.error(`Error creating cancellation notification for user ${recipientUserId}:`, error);
                }
            }

            logger.debug(`Duty cancelled notifications emitted to ${recipientUserIds.length} recipients`);
        } catch (error) {
            console.error('Error emitting duty cancelled notification:', error);
        }
    },

    /**
     * Emit duty relisted notification — fired when a staff cancellation
     * returns a duty to the board via the auto-relist engine. Notifies the
     * hospital with the escalation/boost outcome, and broadcasts to a
     * widened pool of eligible staff (the cancelling staff member is
     * expected to already be excluded from matchingStaffUserIds upstream —
     * see autoRelist.excludedStaff and the query guards that filter on it).
     * @param {Object} duty - Duty object (post-relist, hospital populated)
     * @param {string} hospitalUserId
     * @param {string[]} matchingStaffUserIds - widened eligible staff
     * @param {Object} relistOutcome - result of autoRelistService.applyRelist(...)
     */
    async emitDutyRelisted(duty, hospitalUserId, matchingStaffUserIds, relistOutcome) {
        try {
            const hospitalName = duty.hospital?.hospitalLegalName || duty.hospital?.user?.name || 'Hospital';
            const hospitalLocation = duty.hospital?.location || duty.hospital?.currentAddress || 'Hospital location';

            const dutyDate = new Date(duty.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });
            const dutyTime = `${duty.startTime} - ${duty.endTime}`;

            const { boosted, capReached, urgencyAfter, rateAfter, relistCount } = relistOutcome;

            // --- Hospital notification: what changed as a result of the relist ---
            try {
                const hospitalMessage = capReached
                    ? `Your ${duty.staffRole} duty on ${dutyDate} has now been cancelled and relisted ${relistCount} times — it needs your attention.`
                    : boosted
                        ? `Your ${duty.staffRole} duty on ${dutyDate} was cancelled by staff and is back on the board at a boosted rate of ₹${rateAfter} (urgency: ${urgencyAfter}).`
                        : `Your ${duty.staffRole} duty on ${dutyDate} was cancelled by staff and is back on the board (urgency: ${urgencyAfter}).`;

                const hospitalPayload = {
                    type: 'DUTY_RELISTED',
                    duty: {
                        id: duty._id.toString(),
                        staffRole: duty.staffRole,
                        date: duty.date,
                        startTime: duty.startTime,
                        endTime: duty.endTime,
                        offeredRate: duty.offeredRate,
                        urgency: duty.urgency
                    },
                    relist: { boosted, capReached, relistCount, urgencyAfter, rateAfter },
                    message: hospitalMessage,
                    timestamp: new Date().toISOString()
                };

                const { unreadCount } = await notificationService.createNotificationWithCount(hospitalUserId, 'DUTY_RELISTED', hospitalPayload);
                await notificationDelivery.deliverToUser(hospitalUserId, 'DUTY_RELISTED', hospitalPayload, unreadCount);
            } catch (error) {
                console.error(`Error creating relist notification for hospital ${hospitalUserId}:`, error);
            }

            // --- Widened staff broadcast ---
            if (matchingStaffUserIds && matchingStaffUserIds.length > 0) {
                try {
                    const message = boosted
                        ? `Relisted: ${duty.staffRole} at ${hospitalName}, ${dutyDate} ${dutyTime} — now ₹${rateAfter}/hr (late-cover rate). Tap to accept.`
                        : `Relisted: ${duty.staffRole} at ${hospitalName}, ${dutyDate} ${dutyTime}. Tap to accept.`;

                    const staffPayload = {
                        type: 'DUTY_RELISTED',
                        duty: {
                            id: duty._id.toString(),
                            staffRole: duty.staffRole,
                            date: duty.date,
                            startTime: duty.startTime,
                            endTime: duty.endTime,
                            offeredRate: duty.offeredRate,
                            urgency: duty.urgency,
                            location: hospitalLocation,
                            relisted: true,
                            rateBoosted: boosted
                        },
                        hospital: {
                            id: duty.hospital?._id?.toString() || 'unknown',
                            name: hospitalName
                        },
                        message,
                        timestamp: new Date().toISOString()
                    };

                    await notificationService.createBulkNotifications(matchingStaffUserIds, 'DUTY_RELISTED', staffPayload);
                    if (!duty.offer?.mode && !duty.isDemo) websocketManager.emitToStaffRole(duty.staffRole, 'notification', staffPayload);
                    const relistDelivery = await notificationDelivery.deliverToUsers(matchingStaffUserIds, 'DUTY_RELISTED', staffPayload);

                    const onlineStaffIds = relistDelivery.onlineIds || [];
                    if (onlineStaffIds.length > 0) {
                        await notificationService.markDeliveredForUsers(
                            onlineStaffIds,
                            'DUTY_RELISTED',
                            duty._id.toString()
                        );
                    }

                    logger.debug(`Duty relisted notification emitted to hospital and ${matchingStaffUserIds.length} staff members`);
                } catch (error) {
                    console.error('Error creating staff relist notifications:', error);
                }
            }
        } catch (error) {
            console.error('Error emitting duty relisted notification:', error);
        }
    },

    /**
     * Generic alert to every operations_manager admin — used for dispatch
     * events (relist cap reached, staff/pair/hospital watchlist crossings),
     * never for platform-wide events (those go to super_admin elsewhere) and
     * never to the flagged staff member themselves. Resolves the admin
     * audience itself so call sites don't each repeat the same User query.
     * @param {string} type - Notification type (must exist in Notification.js's enum)
     * @param {string} message
     * @param {Object} [payloadExtra] - Extra fields merged into the payload
     */
    async emitOperationsAlert(type, message, payloadExtra = {}) {
        try {
            const admins = await User.find({ role: 'admin', adminSubRole: 'operations_manager' }).select('_id');
            if (!admins.length) return;

            const adminIds = admins.map(a => a._id.toString());
            const payload = { type, message, timestamp: new Date().toISOString(), ...payloadExtra };

            for (const adminId of adminIds) {
                try {
                    const { unreadCount } = await notificationService.createNotificationWithCount(adminId, type, payload);
                    await notificationDelivery.deliverToUser(adminId, type, payload, unreadCount);
                } catch (err) {
                    console.error(`Error sending operations alert (${type}) to admin ${adminId}:`, err);
                }
            }

            logger.debug(`Operations alert (${type}) sent to ${adminIds.length} operations_manager admin(s)`);
        } catch (error) {
            console.error('Error emitting operations alert:', error);
        }
    },

    /**
     * Repeat push (spec §05) — the 2nd and 3rd notification to the widened
     * staff pool for a still-unfilled relisted duty, at +15/+45 minutes.
     * Deliberately narrower than emitDutyRelisted: no hospital notice (they
     * already got the relist notice once) and no urgency/rate info (nothing
     * changed since the first push — this is a reminder, not a new event).
     * @param {Object} duty
     * @param {string[]} staffUserIds
     * @param {Object} params
     * @param {boolean} params.boosted
     * @param {number} params.pushNumber - 2 or 3
     */
    async emitDutyRelistRepeatPush(duty, staffUserIds, { boosted, pushNumber }) {
        try {
            if (!staffUserIds || staffUserIds.length === 0) return;

            const hospitalName = duty.hospital?.hospitalLegalName || 'a hospital';
            const dutyDate = new Date(duty.date).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
            });
            const dutyTime = `${duty.startTime} - ${duty.endTime}`;

            const message = boosted
                ? `Still open: ${duty.staffRole} at ${hospitalName}, ${dutyDate} ${dutyTime} — ₹${duty.offeredRate}/hr (late-cover rate). Tap to accept.`
                : `Still open: ${duty.staffRole} at ${hospitalName}, ${dutyDate} ${dutyTime}. Tap to accept.`;

            const payload = {
                type: 'DUTY_RELISTED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate,
                    urgency: duty.urgency,
                    relisted: true,
                    rateBoosted: !!boosted,
                    pushNumber
                },
                message,
                timestamp: new Date().toISOString()
            };

            await notificationService.createBulkNotifications(staffUserIds, 'DUTY_RELISTED', payload);
            if (!duty.offer?.mode && !duty.isDemo) websocketManager.emitToStaffRole(duty.staffRole, 'notification', payload);
            await notificationDelivery.deliverToUsers(staffUserIds, 'DUTY_RELISTED', payload);

            logger.debug(`Duty relist repeat push #${pushNumber} sent to ${staffUserIds.length} staff for duty ${duty._id}`);
        } catch (error) {
            console.error('Error emitting duty relist repeat push:', error);
        }
    },

    // "rmo duty on 5 Oct, 09:00–17:00" for notification messages
    describeShift(duty) {
        const day = new Date(duty.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
        return `${duty.staffRole} duty on ${day}, ${duty.startTime}–${duty.endTime}`;
    },

    // One-off duty notices that share a payload shape: admin assignment,
    // expiry, incomplete, status override, invite window ending
    async emitDutyNotice(type, duty, userIds, message, extra = {}) {
        try {
            const recipients = [...new Set((userIds || []).filter(Boolean).map(String))];
            if (!duty || recipients.length === 0) return;

            const payload = {
                type,
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate,
                    urgency: duty.urgency,
                    status: duty.status
                },
                ...extra,
                message,
                timestamp: new Date().toISOString()
            };

            if (recipients.length === 1) {
                const { unreadCount } = await notificationService.createNotificationWithCount(recipients[0], type, payload);
                await notificationDelivery.deliverToUser(recipients[0], type, payload, unreadCount);
            } else {
                await notificationService.createBulkNotifications(recipients, type, payload);
                await notificationDelivery.deliverToUsers(recipients, type, payload);
            }
        } catch (error) {
            console.error(`Error emitting ${type} notification:`, error);
        }
    },

    // Hospital invited these doctors to a duty by name
    async emitDutyInvite(duty, staffUserIds, hospitalName, { count, dutyIds, openAfterInvite, inviteExpiresAt } = {}) {
        try {
            if (!staffUserIds || staffUserIds.length === 0) return;

            const dutyDate = new Date(duty.date).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
            });
            const dutyTime = `${duty.startTime} - ${duty.endTime}`;
            const slots = count > 1 ? `${count} slots: ` : '';

            const payload = {
                type: 'DUTY_INVITE',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate,
                    urgency: duty.urgency
                },
                hospital: { name: hospitalName },
                ...(count > 1 && { count, dutyIds }),
                openAfterInvite: Boolean(openAfterInvite),
                inviteExpiresAt: inviteExpiresAt || null,
                message: `${hospitalName} invited you to a duty — ${slots}${duty.staffRole}, ${dutyDate} ${dutyTime}. Tap to accept.`,
                timestamp: new Date().toISOString()
            };

            await notificationService.createBulkNotifications(staffUserIds, 'DUTY_INVITE', payload);
            await notificationDelivery.deliverToUsers(staffUserIds, 'DUTY_INVITE', payload);

            logger.debug(`Duty invite sent to ${staffUserIds.length} staff for duty ${duty._id}`);
        } catch (error) {
            console.error('Error emitting duty invite:', error);
        }
    },

    // Staged offer widened: tell only the doctors newly in range
    async emitDutyOfferWidened(duty, staffUserIds, radiusKm, hospitalName) {
        try {
            if (!staffUserIds || staffUserIds.length === 0) return;

            const dutyDate = new Date(duty.date).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
            });
            const dutyTime = `${duty.startTime} - ${duty.endTime}`;

            const payload = {
                type: 'NEW_DUTY_OFFER',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate,
                    urgency: duty.urgency,
                    offerRadiusKm: radiusKm
                },
                message: `New duty available near you — ${duty.staffRole} at ${hospitalName || 'a hospital'}, ${dutyDate} ${dutyTime}. Tap to accept.`,
                timestamp: new Date().toISOString()
            };

            await notificationService.createBulkNotifications(staffUserIds, 'NEW_DUTY_OFFER', payload);
            await notificationDelivery.deliverToUsers(staffUserIds, 'NEW_DUTY_OFFER', payload);

            logger.debug(`Duty offer widened to ${radiusKm}km: ${staffUserIds.length} staff notified for duty ${duty._id}`);
        } catch (error) {
            console.error('Error emitting widened duty offer:', error);
        }
    },

    /**
     * Emit duty edited notification to assigned staff
     * @param {Object} duty - Duty object
     * @param {Object} changes - Object containing changed fields
     * @param {string} staffUserId - Staff user ID
     */
    async emitDutyEdited(duty, changes, staffUserId, message) {
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
                ...(message && { message }),
                timestamp: new Date().toISOString()
            };

            // Persist notification for staff
            const { unreadCount } = await notificationService.createNotificationWithCount(staffUserId, 'DUTY_EDITED', payload);

            // Deliver via smart routing (WebSocket or FCM)
            await notificationDelivery.deliverToUser(staffUserId, 'DUTY_EDITED', payload, unreadCount);

            logger.debug(`Duty edited notification emitted to staff ${staffUserId}`);
        } catch (error) {
            console.error('Error emitting duty edited notification:', error);
        }
    },

    // Admin turned auto-relist on/off for a hospital's duty
    async emitAutoRelistChangedByAdmin(duty, hospitalUserId, enabled, reason) {
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
                changes: [{ field: 'Auto-relist', newValue: enabled ? 'On' : 'Off' }],
                reason,
                message: `The HospiLink team turned auto-relist ${enabled ? 'on' : 'off'} for your ${duty.staffRole} duty. Reason: ${reason}`,
                timestamp: new Date().toISOString()
            };

            const { unreadCount } = await notificationService.createNotificationWithCount(hospitalUserId, 'DUTY_EDITED', payload);

            await notificationDelivery.deliverToUser(hospitalUserId, 'DUTY_EDITED', payload, unreadCount);

            logger.debug(`Auto-relist change notification emitted to hospital ${hospitalUserId}`);
        } catch (error) {
            console.error('Error emitting auto-relist change notification:', error);
        }
    },

    // Deliberately does NOT include rating/review content — blind/
    // simultaneous reveal (Phase 3) gates that behind the read paths
    // (getDutyDetail, getCompletedDutiesForStaff, getStaffReviews); putting
    // the real score/text straight into a push payload here would leak it
    // to the staff member immediately regardless of any of that gating.
    async emitReviewReceived(duty, hospital, staff) {
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
                message: "You've received a new review for a completed shift.",
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

            logger.debug(`Review notification sent to staff ${staffUserId}`);

        } catch (error) {
            console.error('Error emitting review notification:', error);
        }
    },

    // Staff -> Hospital direction of emitReviewReceived above — same
    // content-free payload for the same reveal-gating reason.
    async emitHospitalReviewReceived(duty, staff, hospital) {
        try {
            const staffName = staff.fullName || staff.user?.name || 'A staff member';

            const payload = {
                type: 'REVIEW_RECEIVED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime
                },
                staff: {
                    id: staff._id.toString(),
                    name: staffName
                },
                message: "You've received a new review for a completed shift.",
                timestamp: new Date().toISOString()
            };

            const hospitalUserId = hospital.user.toString();

            // Save notification
            const { unreadCount } = await notificationService.createNotificationWithCount(
                hospitalUserId,
                'REVIEW_RECEIVED',
                payload
            );

            // Deliver via smart routing (WebSocket or FCM)
            await notificationDelivery.deliverToUser(hospitalUserId, 'REVIEW_RECEIVED', payload, unreadCount);

            logger.debug(`Review notification sent to hospital ${hospitalUserId}`);

        } catch (error) {
            console.error('Error emitting hospital review notification:', error);
        }
    },

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
                
                logger.debug(`Duty in-progress notification sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending duty in-progress notification to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting duty in-progress notification:', error);
        }
    },

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

                logger.debug(`Duty completed notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending duty completed notification to hospital ${hospitalUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting duty completed notification:', error);
        }
    },

    // Tells the doctor their duty is confirmed, with the amount and how the
    // hospital says it paid. confirmedBy: 'hospital' (end code) or 'admin'.
    async emitDutyConfirmedToStaff(duty, staffUserId, { confirmedBy = 'hospital', reason = null } = {}) {
        try {
            if (!duty || !staffUserId) return;
            const amount = typeof duty.totalPayment === 'number' ? `₹${Math.round(duty.totalPayment).toLocaleString('en-IN')}` : null;
            const methods = { upi: 'UPI', cash: 'cash', bank: 'bank transfer' };
            let payment = '';
            if (duty.isPaid === true) payment = methods[duty.paymentMethod] ? ` Paid by ${methods[duty.paymentMethod]}.` : ' Marked paid.';
            else if (duty.isPaid === false || duty.paymentMethod === 'will_pay_later') payment = ' The hospital will pay later.';

            const who = confirmedBy === 'admin' ? 'HospiLink confirmed' : 'The hospital confirmed';
            const message = `${who} your ${this.describeShift(duty)}${amount ? `: ${amount}` : ''}.${payment}${reason ? ` Reason: ${reason}` : ''}`;

            const payload = {
                type: 'DUTY_COMPLETED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    totalPayment: duty.totalPayment,
                    paymentMethod: duty.paymentMethod || null,
                    isPaid: typeof duty.isPaid === 'boolean' ? duty.isPaid : null
                },
                confirmedBy,
                message,
                completedAt: new Date(duty.completedAt || Date.now()).toISOString(),
                timestamp: new Date().toISOString()
            };

            const { unreadCount } = await notificationService.createNotificationWithCount(String(staffUserId), 'DUTY_COMPLETED', payload);
            await notificationDelivery.deliverToUser(String(staffUserId), 'DUTY_COMPLETED', payload, unreadCount);
        } catch (error) {
            console.error('Error emitting duty confirmed notification to staff:', error);
        }
    },

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

                logger.debug(`Rate-hospital prompt sent to staff ${staffUserId}`);
            } catch (error) {
                console.error(`Error sending rate-hospital prompt to staff ${staffUserId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting rate-hospital prompt:', error);
        }
    },

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

            logger.debug(`Duty unassigned 15-min notification sent to hospital ${hospitalUserId} for duty ${duty._id}`);
        } catch (error) {
            console.error('Error emitting duty unassigned 15-min notification:', error);
        }
    },

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

            logger.debug(`Duty unfilled CRITICAL notification sent to hospital ${hospitalUserId} for duty ${duty._id}`);
        } catch (error) {
            console.error('Error emitting duty unfilled critical notification:', error);
        }
    },

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

            logger.debug(`Emergency admin alert (${reason}) sent to ${adminUserIds.length} admin(s) for duty ${duty._id}`);
        } catch (error) {
            console.error('Error emitting emergency admin alert:', error);
        }
    }
};
