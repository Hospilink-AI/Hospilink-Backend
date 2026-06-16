const websocketManager = require('./websocketManager');
const fcmService = require('./fcm.service');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');

/**
 * Notification Delivery Service
 * Smart routing between WebSocket (online) and FCM (offline)
 */

// Map notification types to FCM titles
const FCM_TITLES = {
    DUTY_CREATED: 'Duty Created',
    EMERGENCY_REQUEST_ACKNOWLEDGED: 'Emergency Request Sent',
    NEW_DUTY_OFFER: 'New Duty Available',
    EMERGENCY_DUTY_REQUEST: '🚨 Emergency Duty',
    DUTY_CONFIRMED: 'Duty Confirmed',
    STAFF_ASSIGNED: 'Staff Assigned',
    NAVIGATE_TO_DUTY: 'Duty Starting Soon',
    STAFF_EN_ROUTE: 'Staff En Route',
    STAFF_ON_SITE: 'Staff Arrived',
    DUTY_IN_PROGRESS: 'Duty In Progress',
    DUTY_CANCELLED_BY_HOSPITAL: 'Duty Cancelled',
    DUTY_CANCELLED_BY_STAFF: 'Duty Cancelled',
    DUTY_EDITED: 'Duty Updated',
    DUTY_COMPLETED: 'Duty Completed',
    REVIEW_RECEIVED: 'New Review',
    DOCUMENT_VERIFIED: 'Document Verified',
    DOCUMENT_REJECTED: 'Document Rejected',
    NEW_HOSPITAL_REGISTRATION: 'New Hospital',
    NEW_STAFF_REGISTRATION: 'New Staff',
    DUTY_UNASSIGNED_15MIN: 'Duty Unassigned Alert',
    DUTY_UNFILLED_CRITICAL: 'Critical: Duty Unfilled',
    EMERGENCY_ADMIN_ALERT: 'Emergency Alert',
    PASSWORD_CHANGED: 'Password Changed',
    ACCOUNT_SUSPENDED: 'Account Suspended',
    ACCOUNT_ACTIVATED: 'Account Restored'
};

class NotificationDeliveryService {
    /**
     * Deliver notification to a single user
     * Routes to WebSocket if online, FCM if offline
     * @param {string} userId - User ID
     * @param {string} type - Notification type
     * @param {Object} payload - Notification payload
     * @param {number} unreadCount - Unread notification count
     * @returns {Promise<Object>} Delivery result
     */
    async deliverToUser(userId, type, payload, unreadCount = 0) {
        try {
            const isOnline = websocketManager.isUserOnline(userId);

            if (isOnline) {
                // User is online - deliver via WebSocket
                websocketManager.sendUnreadCount(userId, unreadCount);
                websocketManager.emitToUser(userId, 'notification', payload);

                logger.info(`Delivered notification to user ${userId} via WebSocket (online)`);

                return {
                    success: true,
                    method: 'websocket',
                    userId
                };
            } else {
                // User is offline - deliver via FCM push
                const title = FCM_TITLES[type] || 'HospiLink';
                const body = payload.message || 'You have a new notification';

                const fcmData = {
                    type,
                    unreadCount: String(unreadCount),
                    notificationId: payload.notificationId || '',
                    dutyId: payload.duty?.id || '',
                    timestamp: payload.timestamp || new Date().toISOString()
                };

                const result = await fcmService.sendToUser(userId, title, body, fcmData);

                if (result.success) {
                    logger.info(`Delivered notification to user ${userId} via FCM (offline)`);
                } else {
                    logger.warn(`Failed to deliver FCM to user ${userId}: ${result.reason || result.error}`);
                }

                return {
                    success: result.success,
                    method: 'fcm',
                    userId,
                    reason: result.reason
                };
            }
        } catch (error) {
            logger.error(`Error delivering notification to user ${userId}:`, error.message);
            return {
                success: false,
                error: error.message,
                userId
            };
        }
    }

    /**
     * Deliver notification to multiple users
     * Splits into online (WebSocket) and offline (FCM) batches
     * @param {string[]} userIds - Array of user IDs
     * @param {string} type - Notification type
     * @param {Object} payload - Notification payload
     * @returns {Promise<Object>} Delivery result
     */
    async deliverToUsers(userIds, type, payload) {
        try {
            if (!userIds || userIds.length === 0) {
                return { success: true, onlineCount: 0, offlineCount: 0 };
            }

            // Split users into online and offline
            const onlineIds = [];
            const offlineIds = [];

            for (const userId of userIds) {
                if (websocketManager.isUserOnline(userId)) {
                    onlineIds.push(userId);
                } else {
                    offlineIds.push(userId);
                }
            }

            logger.info(`Delivering to ${userIds.length} users: ${onlineIds.length} online, ${offlineIds.length} offline`);

            // Deliver to online users via WebSocket
            if (onlineIds.length > 0) {
                for (const userId of onlineIds) {
                    websocketManager.emitToUser(userId, 'notification', payload);
                }
            }

            // Deliver to offline users via FCM
            let fcmResult = { success: true, successCount: 0, failureCount: 0 };
            if (offlineIds.length > 0) {
                const title = FCM_TITLES[type] || 'HospiLink';
                const body = payload.message || 'You have a new notification';

                const fcmData = {
                    type,
                    dutyId: payload.duty?.id || '',
                    timestamp: payload.timestamp || new Date().toISOString()
                };

                fcmResult = await fcmService.sendToUsers(offlineIds, title, body, fcmData);
            }

            return {
                success: true,
                onlineCount: onlineIds.length,
                offlineCount: offlineIds.length,
                fcmSuccess: fcmResult.successCount || 0,
                fcmFailure: fcmResult.failureCount || 0
            };
        } catch (error) {
            logger.error('Error delivering to multiple users:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Deliver notification with automatic persistence and count
     * Convenience method that combines notification creation and delivery
     * @param {string} userId - User ID
     * @param {string} type - Notification type
     * @param {Object} payload - Notification payload
     * @returns {Promise<Object>} Result
     */
    async createAndDeliver(userId, type, payload) {
        try {
            // Create notification in database
            const { notification, unreadCount } = await notificationService.createNotificationWithCount(
                userId,
                type,
                payload
            );

            // Deliver via appropriate channel
            const deliveryResult = await this.deliverToUser(userId, type, payload, unreadCount);

            return {
                success: true,
                notification,
                unreadCount,
                deliveryMethod: deliveryResult.method
            };
        } catch (error) {
            logger.error('Error in createAndDeliver:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Export singleton instance
module.exports = new NotificationDeliveryService();
