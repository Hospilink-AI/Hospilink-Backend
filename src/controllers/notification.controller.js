const notificationService = require('../services/notificationService');
const websocketManager = require('../services/websocketManager');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * Get user's notifications with pagination
 * @route GET /api/notifications
 * @access Private
 */
exports.getNotifications = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;

    const notifications = await notificationService.getUserNotifications(userId, limit, skip);

    res.status(200).json({
        success: true,
        count: notifications.length,
        data: notifications
    });
});

/**
 * Mark notification as read
 * @route PUT /api/notifications/:id/read
 * @access Private
 */
exports.markAsRead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const notification = await notificationService.markAsRead(id, userId);

    if (!notification) {
        return res.status(404).json({
            success: false,
            message: 'Notification not found or unauthorized'
        });
    }

    // Send updated unread count
    const unreadCount = await notificationService.getUnreadCount(userId);
    websocketManager.sendUnreadCount(userId, unreadCount);

    res.status(200).json({
        success: true,
        message: 'Notification marked as read',
        data: notification
    });
});

/**
 * Mark multiple notifications as read
 * @route PUT /api/notifications/read-multiple
 * @access Private
 */
exports.markMultipleAsRead = asyncHandler(async (req, res) => {
    const { notificationIds } = req.body;
    const userId = req.user.id;

    if (!notificationIds || !Array.isArray(notificationIds) || notificationIds.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'notificationIds array is required'
        });
    }

    const result = await notificationService.markMultipleAsRead(notificationIds, userId);

    // Send updated unread count
    const unreadCount = await notificationService.getUnreadCount(userId);
    websocketManager.sendUnreadCount(userId, unreadCount);

    res.status(200).json({
        success: true,
        message: `${result.modifiedCount} notifications marked as read`,
        data: result
    });
});

/**
 * Mark all notifications as read
 * @route PUT /api/notifications/read-all
 * @access Private
 */
exports.markAllAsRead = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const result = await notificationService.markAllAsRead(userId);

    const unreadCount = await notificationService.getUnreadCount(userId);
    websocketManager.sendUnreadCount(userId, unreadCount);

    res.status(200).json({
        success: true,
        message: `${result.modifiedCount} notifications marked as read`,
        data: result
    });
});


exports.getUnreadCount = asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const count = await notificationService.getUnreadCount(userId);

    res.status(200).json({
        success: true,
        count: count
    });
});
