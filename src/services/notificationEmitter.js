const notificationService = require('./notificationService');
const websocketManager = require('./websocketManager');

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
            const payload = {
                type: 'DUTY_CREATED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    offeredRate: duty.offeredRate,
                    urgency: duty.urgency,
                    description: duty.description,
                    location: hospital.location || hospital.currentAddress
                },
                hospital: {
                    id: hospital._id.toString(),
                    name: hospital.hospitalLegalName || hospital.user?.name
                },
                timestamp: new Date().toISOString()
            };

            // Persist notification for hospital (creator)
            try {
                const { unreadCount } = await notificationService.createNotificationWithCount(hospitalUserId, 'DUTY_CREATED', payload);
                websocketManager.sendUnreadCount(hospitalUserId, unreadCount);
                // Emit to hospital
                websocketManager.emitToUser(hospitalUserId, 'notification', payload);
            } catch (error) {
                console.error(`Error creating notification for hospital ${hospitalUserId}:`, error);
            }

            // Persist notifications for each staff member (bulk operation)
            if (matchingStaffUserIds.length > 0) {
                try {
                    await notificationService.createBulkNotifications(matchingStaffUserIds, 'DUTY_CREATED', payload);

                    // Batch fetch unread counts for all staff
                    const unreadCounts = await notificationService.getBulkUnreadCounts(matchingStaffUserIds);

                    // Send unread counts to each staff member
                    for (const staffUserId of matchingStaffUserIds) {
                        const count = unreadCounts[staffUserId] || 0;
                        websocketManager.sendUnreadCount(staffUserId, count);
                    }
                } catch (error) {
                    console.error('Error creating bulk notifications for staff:', error);
                }
            }

            // Emit to role room (for real-time to all matching staff)
            websocketManager.emitToStaffRole(duty.staffRole, 'notification', payload);

            console.log(`Duty created notification emitted to hospital and ${matchingStaffUserIds.length} staff members`);
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
        const payload = {
            type: 'DUTY_ACCEPTED',
            duty: {
                id: duty._id.toString(),
                staffRole: duty.staffRole,
                date: duty.date,
                startTime: duty.startTime,
                endTime: duty.endTime,
                offeredRate: duty.offeredRate
            },
            staff: {
                id: staff._id.toString(),
                name: staff.fullName || staff.user?.name
            },
            acceptedAt: duty.assignedAt || new Date().toISOString(),
            timestamp: new Date().toISOString()
        };

        // Persist notification for hospital (isolated try-catch)
        try {
            const { unreadCount } = await notificationService.createNotificationWithCount(hospitalUserId, 'DUTY_ACCEPTED', payload);
            websocketManager.sendUnreadCount(hospitalUserId, unreadCount);
            websocketManager.emitToUser(hospitalUserId, 'notification', payload);
            console.log(`Duty accepted notification sent to hospital ${hospitalUserId}`);
        } catch (error) {
            console.error(`Error sending duty accepted notification to hospital ${hospitalUserId}:`, error);
        }

        // Persist notification for staff (isolated try-catch)
        try {
            const { unreadCount } = await notificationService.createNotificationWithCount(staffUserId, 'DUTY_ACCEPTED', payload);
            websocketManager.sendUnreadCount(staffUserId, unreadCount);
            websocketManager.emitToUser(staffUserId, 'notification', payload);
            console.log(`Duty accepted notification sent to staff ${staffUserId}`);
        } catch (error) {
            console.error(`Error sending duty accepted notification to staff ${staffUserId}:`, error);
        }
    }

    /**
     * Emit duty status changed notification to both parties
     * @param {Object} duty - Duty object
     * @param {string} previousStatus - Previous duty status
     * @param {string} newStatus - New duty status
     * @param {string} hospitalUserId - Hospital user ID
     * @param {string} staffUserId - Staff user ID
     */
    async emitDutyStatusChanged(duty, previousStatus, newStatus, hospitalUserId, staffUserId) {
        const payload = {
            type: 'DUTY_STATUS_CHANGED',
            duty: {
                id: duty._id.toString(),
                staffRole: duty.staffRole,
                date: duty.date,
                startTime: duty.startTime,
                endTime: duty.endTime
            },
            previousStatus: previousStatus,
            newStatus: newStatus,
            timestamp: new Date().toISOString()
        };

        // Persist notification for hospital (isolated try-catch)
        try {
            const { unreadCount } = await notificationService.createNotificationWithCount(hospitalUserId, 'DUTY_STATUS_CHANGED', payload);
            websocketManager.sendUnreadCount(hospitalUserId, unreadCount);
            websocketManager.emitToUser(hospitalUserId, 'notification', payload);
            console.log(`Duty status changed notification sent to hospital ${hospitalUserId}`);
        } catch (error) {
            console.error(`Error sending duty status changed notification to hospital ${hospitalUserId}:`, error);
        }

        // Persist notification for staff (isolated try-catch)
        try {
            const { unreadCount } = await notificationService.createNotificationWithCount(staffUserId, 'DUTY_STATUS_CHANGED', payload);
            websocketManager.sendUnreadCount(staffUserId, unreadCount);
            websocketManager.emitToUser(staffUserId, 'notification', payload);
            console.log(`Duty status changed notification sent to staff ${staffUserId}`);
        } catch (error) {
            console.error(`Error sending duty status changed notification to staff ${staffUserId}:`, error);
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
            const payload = {
                type: 'DUTY_CANCELLED',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime
                },
                cancelledBy: {
                    id: cancelledByUser._id.toString(),
                    name: cancelledByUser.name,
                    role: cancelledByUser.role
                },
                reason: reason,
                reasonText: reasonText || null,
                timestamp: new Date().toISOString()
            };

            // Persist notifications for recipients (bulk operation)
            if (recipientUserIds.length > 0) {
                try {
                    await notificationService.createBulkNotifications(recipientUserIds, 'DUTY_CANCELLED', payload);

                    // Batch fetch unread counts for all recipients
                    const unreadCounts = await notificationService.getBulkUnreadCounts(recipientUserIds);

                    // Send unread counts to each recipient
                    for (const recipientUserId of recipientUserIds) {
                        const count = unreadCounts[recipientUserId] || 0;
                        websocketManager.sendUnreadCount(recipientUserId, count);
                    }
                } catch (error) {
                    console.error('Error creating bulk cancellation notifications:', error);
                }
            }

            // Emit to recipients
            websocketManager.emitToUsers(recipientUserIds, 'notification', payload);

            console.log(`Duty cancelled notification emitted to ${recipientUserIds.length} recipients`);
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
                    ? `You received a ${rating}⭐ review: "${reviewText}"` : `You received a ${rating}⭐ rating from hospital`,
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
    // Emit Emergency Duty Request Notification
    async emitEmergencyDutyRequest(duty, hospital, nearbyStaffUserIds, ward = 'General') {
        try {
            const role = duty.staffRole.replace(/_/g, ' ').toUpperCase();

            const message = `EMERGENCY: Immediate ${role} required at ${hospital.hospitalLegalName || hospital.user?.name} — ${ward}. Critical response needed. Tap to accept.`;

            const payload = {
                type: 'EMERGENCY_DUTY_REQUEST',
                priority: 'CRITICAL',
                duty: {
                    id: duty._id.toString(),
                    staffRole: duty.staffRole,
                    date: duty.date,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    urgency: duty.urgency,
                    offeredRate: duty.offeredRate
                },
                hospital: {
                    id: hospital._id.toString(),
                    name: hospital.hospitalLegalName || hospital.user?.name
                },
                message,
                ward,
                timestamp: new Date().toISOString()
            };

            //  Persist notifications (bulk)
            if (nearbyStaffUserIds.length > 0) {
                await notificationService.createBulkNotifications(
                    nearbyStaffUserIds,
                    'EMERGENCY_DUTY_REQUEST',
                    payload
                );
                // Send unread count
                const unreadCounts = await notificationService.getBulkUnreadCounts(nearbyStaffUserIds);

                for (const userId of nearbyStaffUserIds) {
                    websocketManager.sendUnreadCount(userId, unreadCounts[userId] || 0);
                }
            }

            if (nearbyStaffUserIds.length > 0) {
                websocketManager.emitToUsers(nearbyStaffUserIds, 'notification', payload);
            } else {
                websocketManager.emitToStaffRole(duty.staffRole, 'notification', payload);
            }

            console.log(`Emergency notification sent to ${nearbyStaffUserIds.length} staff`);

        } catch (error) {
            console.error('Error emitting emergency duty notification:', error);
        }
    }    
    //Emit document verified notification
    async emitDocumentVerified(userId, documentType) {
        try {
            const payload = {
                type: 'DOCUMENT_VERIFIED',
                message: `Your ${documentType} has been verified by the HospiLink team. You are fully compliant and eligible for duties.`,
                documentType,
                timestamp: new Date().toISOString()
            };

            const { unreadCount } =
                await notificationService.createNotificationWithCount(
                    userId,
                    'DOCUMENT_VERIFIED',
                    payload
                );

            websocketManager.sendUnreadCount(userId, unreadCount);
            websocketManager.emitToUser(userId, 'notification', payload);

            console.log(`Document verified notification sent to user ${userId}`);

        } catch (error) {
            console.error('Error sending document verified notification:', error);
        }
    }

    //Emit document rejected notification
    async emitDocumentRejected(userId, documentType, reason) {
        try {
            const payload = {
                type: 'DOCUMENT_REJECTED',
                message: `Your ${documentType} was not accepted. Reason: ${reason}. Please re-upload a clear, valid document.`,
                documentType,
                rejectionReason: reason,
                timestamp: new Date().toISOString()
            };

            const { unreadCount } =
                await notificationService.createNotificationWithCount(
                    userId,
                    'DOCUMENT_REJECTED',
                    payload
                );

            websocketManager.sendUnreadCount(userId, unreadCount);
            websocketManager.emitToUser(userId, 'notification', payload);

            console.log(`Document rejected notification sent to user ${userId}`);

        } catch (error) {
            console.error('Error sending document rejected notification:', error);
        }
    }
}

module.exports = new NotificationEmitter();
