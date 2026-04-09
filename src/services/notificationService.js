const Notification = require('../models/Notification');

/**
 * Notification Service
 * Handles notification persistence and database operations
 */
class NotificationService {
    /**
     * Create and persist notification
     * @param {string} recipientId - User ID of recipient
     * @param {string} type - Notification type
     * @param {Object} payload - Notification payload
     * @returns {Promise<Object>} Created notification
     */
    async createNotification(recipientId, type, payload) {
        try {
            const notification = new Notification({
                recipient: recipientId,
                type,
                payload,
                isRead: false,
                createdAt: new Date()
            });

            await notification.save();
            console.log(`Notification created: ${type} for user ${recipientId}`);
            return notification;
        } catch (error) {
            console.error('Error creating notification:', error);
            throw error;
        }
    }

    /**
     * Get user's notifications with pagination
     * @param {string} userId - User ID
     * @param {number} limit - Maximum number of notifications to return
     * @param {number} skip - Number of notifications to skip
     * @returns {Promise<Array>} Array of notifications
     */
    async getUserNotifications(userId, limit = 50, skip = 0) {
        try {
            const notifications = await Notification.find({ recipient: userId })
                .sort({ createdAt: -1 })
                .limit(limit)
                .skip(skip)
                .lean();

            return notifications;
        } catch (error) {
            console.error('Error fetching user notifications:', error);
            throw error;
        }
    }

    /**
     * Mark notification as read
     * @param {string} notificationId - Notification ID
     * @param {string} userId - User ID (for authorization)
     * @returns {Promise<Object|null>} Updated notification or null
     */
    async markAsRead(notificationId, userId) {
        try {
            const notification = await Notification.findOneAndUpdate(
                { _id: notificationId, recipient: userId },
                { isRead: true },
                { new: true }
            );

            if (notification) {
                console.log(`Notification ${notificationId} marked as read`);
            }

            return notification;
        } catch (error) {
            console.error('Error marking notification as read:', error);
            throw error;
        }
    }

    /**
     * Mark multiple notifications as read
     * @param {string[]} notificationIds - Array of notification IDs
     * @param {string} userId - User ID (for authorization)
     * @returns {Promise<Object>} Update result
     */
    async markMultipleAsRead(notificationIds, userId) {
        try {
            const result = await Notification.updateMany(
                { _id: { $in: notificationIds }, recipient: userId },
                { isRead: true }
            );

            console.log(`Marked ${result.modifiedCount} notifications as read`);
            return result;
        } catch (error) {
            console.error('Error marking multiple notifications as read:', error);
            throw error;
        }
    }

    /**
     * Get unread notification count for user
     * @param {string} userId - User ID
     * @returns {Promise<number>} Unread count
     */
    async getUnreadCount(userId) {
        try {
            const count = await Notification.countDocuments({
                recipient: userId,
                isRead: false
            });

            return count;
        } catch (error) {
            console.error('Error fetching unread count:', error);
            throw error;
        }
    }

    /**
     * Create bulk notifications for multiple recipients (optimized for N+1 prevention)
     * @param {string[]} recipientIds - Array of user IDs
     * @param {string} type - Notification type
     * @param {Object} payload - Notification payload
     * @returns {Promise<Object>} Insert result
     */
    async createBulkNotifications(recipientIds, type, payload) {
        try {
            if (!recipientIds || recipientIds.length === 0) {
                return { insertedCount: 0 };
            }

            const notifications = recipientIds.map(recipientId => ({
                recipient: recipientId,
                type,
                payload,
                priority: payload.priority || 'NORMAL',
                isRead: false,
                createdAt: new Date()
            }));

            const result = await Notification.insertMany(notifications, { ordered: false });
            console.log(`Bulk created ${result.length} notifications of type ${type}`);
            return { insertedCount: result.length };
        } catch (error) {
            console.error('Error creating bulk notifications:', error);
            throw error;
        }
    }

    /**
     * Get unread counts for multiple users in a single query (optimized for N+1 prevention)
     * @param {string[]} userIds - Array of user IDs
     * @returns {Promise<Object>} Object mapping userId to unread count
     */
    async getBulkUnreadCounts(userIds) {
        try {
            if (!userIds || userIds.length === 0) {
                return {};
            }

            const results = await Notification.aggregate([
                {
                    $match: {
                        recipient: { $in: userIds.map(id => id.toString()) },
                        isRead: false
                    }
                },
                {
                    $group: {
                        _id: '$recipient',
                        count: { $sum: 1 }
                    }
                }
            ]);

            // Convert array to object for easy lookup
            const countsMap = {};
            results.forEach(result => {
                countsMap[result._id.toString()] = result.count;
            });

            // Ensure all userIds have a count (even if 0)
            userIds.forEach(userId => {
                if (countsMap[userId.toString()] === undefined) {
                    countsMap[userId.toString()] = 0;
                }
            });

            return countsMap;
        } catch (error) {
            console.error('Error fetching bulk unread counts:', error);
            throw error;
        }
    }

    /**
     * Get notifications created after timestamp (for reconnection)
     * @param {string} userId - User ID
     * @param {Date} timestamp - Timestamp to query from
     * @returns {Promise<Array>} Array of notifications
     */
    async getNotificationsSince(userId, timestamp, limit = 100) {
        try {
            const notifications = await Notification.find({
                recipient: userId,
                createdAt: { $gt: timestamp }
            })
                .sort({ createdAt: 1 }) // Ascending order for chronological delivery
                .limit(limit)
                .lean();

            return notifications;
        } catch (error) {
            console.error('Error fetching notifications since timestamp:', error);
            throw error;
        }
    }

    /**
     * Create notification and return unread count in one operation (optimized)
     * Useful for single-recipient notifications to avoid separate getUnreadCount call
     * @param {string} recipientId - User ID of recipient
     * @param {string} type - Notification type
     * @param {Object} payload - Notification payload
     * @returns {Promise<Object>} { notification, unreadCount }
     */
    async createNotificationWithCount(recipientId, type, payload) {
        try {
            const notification = new Notification({
                recipient: recipientId,
                type,
                payload,
                isRead: false,
                createdAt: new Date()
            });

            await notification.save();

            // Get unread count in the same operation
            const unreadCount = await Notification.countDocuments({
                recipient: recipientId,
                isRead: false
            });

            console.log(`Notification created: ${type} for user ${recipientId} (unread: ${unreadCount})`);
            return { notification, unreadCount };
        } catch (error) {
            console.error('Error creating notification with count:', error);
            throw error;
        }
    }
}

module.exports = new NotificationService();
