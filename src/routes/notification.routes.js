const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notification.controller');
const { protect } = require('../middleware/auth.middleware');
const { 
    validateNotificationId, 
    validateBulkNotificationRead,
    validateNotificationQuery,
    validateUnreadCountQuery
} = require('../middleware/validation.middleware');

// Apply authentication to all notification routes
router.use(protect);

// Get user's notifications
router.get('/', validateNotificationQuery, notificationController.getNotifications);

// Get unread count
router.get('/unread-count', validateUnreadCountQuery, notificationController.getUnreadCount);

// Mark notification as read
router.put('/:id/read', validateNotificationId, notificationController.markAsRead);

// Mark multiple notifications as read
router.put('/read-multiple', validateBulkNotificationRead, notificationController.markMultipleAsRead);

module.exports = router;