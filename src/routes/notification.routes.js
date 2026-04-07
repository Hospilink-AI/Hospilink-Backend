const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notification.controller');
const { protect } = require('../middleware/auth.middleware');

// Apply authentication to all notification routes
router.use(protect);

// Get user's notifications
router.get('/', notificationController.getNotifications);

// Get unread count
router.get('/unread-count', notificationController.getUnreadCount);

// Mark notification as read
router.put('/:id/read', notificationController.markAsRead);

// Mark multiple notifications as read
router.put('/read-multiple', notificationController.markMultipleAsRead);

module.exports = router;
