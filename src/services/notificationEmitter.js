const notificationService = require('./notificationService');
const websocketManager = require('./websocketManager');
const geocodingService = require('./geocoding.service');
const MedicalStaff = require('../models/MedicalStaff');

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
                websocketManager.sendUnreadCount(hospitalUserId, unreadCount);
                websocketManager.emitToUser(hospitalUserId, 'notification', hospitalPayload);
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
                    
                    // Batch fetch unread counts for all staff
                    const unreadCounts = await notificationService.getBulkUnreadCounts(matchingStaffUserIds);
                    
                    // Send unread counts to each staff member
                    for (const staffUserId of matchingStaffUserIds) {
                        const count = unreadCounts[staffUserId] || 0;
                        websocketManager.sendUnreadCount(staffUserId, count);
                    }

                    // Broadcast to role room for real-time notification
                    websocketManager.emitToStaffRole(duty.staffRole, 'notification', staffPayload);

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
            const Hospital = require('../models/Hospital');
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
                websocketManager.sendUnreadCount(hospitalUserId, unreadCount);
                websocketManager.emitToUser(hospitalUserId, 'notification', hospitalPayload);
                console.log(`Staff assigned notification sent to hospital ${hospitalUserId}`);
            } catch (error) {
                console.error(`Error sending staff assigned notification to hospital ${hospitalUserId}:`, error);
            }

            // Persist notification for staff (isolated try-catch)
            try {
                console.log(`Attempting to send DUTY_CONFIRMED to staff ${staffUserId}`);
                const { unreadCount } = await notificationService.createNotificationWithCount(staffUserId, 'DUTY_CONFIRMED', staffPayload);
                console.log(`DUTY_CONFIRMED notification created in DB for staff ${staffUserId}, unread count: ${unreadCount}`);
                websocketManager.sendUnreadCount(staffUserId, unreadCount);
                websocketManager.emitToUser(staffUserId, 'notification', staffPayload);
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
            const Hospital = require('../models/Hospital');
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
                
                websocketManager.sendUnreadCount(hospitalUserId, unreadCount);
                websocketManager.emitToUser(hospitalUserId, 'notification', payload);
                
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
            const Hospital = require('../models/Hospital');
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
                
                websocketManager.sendUnreadCount(hospitalUserId, unreadCount);
                websocketManager.emitToUser(hospitalUserId, 'notification', payload);
                
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
            const Hospital = require('../models/Hospital');
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
                
                websocketManager.sendUnreadCount(staffUserId, unreadCount);
                websocketManager.emitToUser(staffUserId, 'notification', payload);
                
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
            const Hospital = require('../models/Hospital');
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
                    
                    // Send unread count
                    websocketManager.sendUnreadCount(recipientUserId, unreadCount);
                    
                    // Emit real-time notification
                    websocketManager.emitToUser(recipientUserId, 'notification', payload);
                    
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
            websocketManager.sendUnreadCount(staffUserId, unreadCount);

            // Emit to staff
            websocketManager.emitToUser(staffUserId, 'notification', payload);

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
            await notificationService.createNotification(
                staffUserId,
                'REVIEW_RECEIVED',
                payload
            );

            const unreadCount = await notificationService.getUnreadCount(staffUserId);

            websocketManager.sendUnreadCount(staffUserId, unreadCount);

            // Real-time emit
            websocketManager.emitToUser(staffUserId, 'notification', payload);

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
                
                websocketManager.sendUnreadCount(staffUserId, unreadCount);
                websocketManager.emitToUser(staffUserId, 'notification', payload);
                
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
            const Hospital = require('../models/Hospital');
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
                
                websocketManager.sendUnreadCount(hospitalUserId, unreadCount);
                websocketManager.emitToUser(hospitalUserId, 'notification', payload);
                
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
            const User = require('../models/User');
            const adminUsers = await User.find({ role: 'admin' }).select('_id');

            if (adminUsers.length === 0) {
                console.log('No admin users found to notify');
                return;
            }

            const adminUserIds = adminUsers.map(admin => admin._id.toString());

            // Persist notifications for all admins
            try {
                await notificationService.createBulkNotifications(adminUserIds, 'NEW_HOSPITAL_REGISTRATION', payload);
                
                // Batch fetch unread counts
                const unreadCounts = await notificationService.getBulkUnreadCounts(adminUserIds);
                
                // Send unread counts and emit to each admin
                for (const adminUserId of adminUserIds) {
                    const count = unreadCounts[adminUserId] || 0;
                    websocketManager.sendUnreadCount(adminUserId, count);
                    websocketManager.emitToUser(adminUserId, 'notification', payload);
                }

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
            const User = require('../models/User');
            const adminUsers = await User.find({ role: 'admin' }).select('_id');

            if (adminUsers.length === 0) {
                console.log('No admin users found to notify');
                return;
            }

            const adminUserIds = adminUsers.map(admin => admin._id.toString());

            // Persist notifications for all admins
            try {
                await notificationService.createBulkNotifications(adminUserIds, 'NEW_STAFF_REGISTRATION', payload);
                
                // Batch fetch unread counts
                const unreadCounts = await notificationService.getBulkUnreadCounts(adminUserIds);
                
                // Send unread counts and emit to each admin
                for (const adminUserId of adminUserIds) {
                    const count = unreadCounts[adminUserId] || 0;
                    websocketManager.sendUnreadCount(adminUserId, count);
                    websocketManager.emitToUser(adminUserId, 'notification', payload);
                }

                console.log(`New staff registration notification sent to ${adminUserIds.length} admins`);
            } catch (error) {
                console.error('Error sending staff registration notifications:', error);
            }
        } catch (error) {
            console.error('Error emitting new staff registration notification:', error);
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
                
                websocketManager.sendUnreadCount(document.userId, unreadCount);
                websocketManager.emitToUser(document.userId, 'notification', payload);
                
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
                
                websocketManager.sendUnreadCount(document.userId, unreadCount);
                websocketManager.emitToUser(document.userId, 'notification', payload);
                
                console.log(`Document rejected notification sent to ${userRole} ${document.userId}`);
            } catch (error) {
                console.error(`Error sending document rejected notification to ${userRole} ${document.userId}:`, error);
            }
        } catch (error) {
            console.error('Error emitting document rejected notification:', error);
        }
    }
}

module.exports = new NotificationEmitter();
