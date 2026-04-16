const express = require('express');
const router = express.Router();
const activityLogController = require('../controllers/activityLog.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

/**
 * Activity Log Routes
 * All routes require authentication and admin role
 */

// Apply auth and admin middleware to all routes
router.use(protect);
router.use(authorize('admin'));

/**
 * @route   GET /api/admin/activity-logs/stats
 * @desc    Get activity statistics
 * @access  Admin
 */
router.get('/stats', activityLogController.getActivityStats);

/**
 * @route   GET /api/admin/activity-logs/critical
 * @desc    Get recent critical activities
 * @access  Admin
 */
router.get('/critical', activityLogController.getRecentCriticalActivities);

/**
 * @route   GET /api/admin/activity-logs/timeline
 * @desc    Get activity timeline
 * @access  Admin
 */
router.get('/timeline', activityLogController.getActivityTimeline);

/**
 * @route   GET /api/admin/activity-logs/search
 * @desc    Search activity logs
 * @access  Admin
 */
router.get('/search', activityLogController.searchActivityLogs);

/**
 * @route   GET /api/admin/activity-logs/export
 * @desc    Export activity logs
 * @access  Admin
 */
router.get('/export', activityLogController.exportActivityLogs);

/**
 * @route   GET /api/admin/activity-logs/:id
 * @desc    Get activity log by ID
 * @access  Admin
 */
router.get('/:id', activityLogController.getActivityLogById);

/**
 * @route   GET /api/admin/activity-logs
 * @desc    Get activity logs with filters and pagination
 * @access  Admin
 */
router.get('/', activityLogController.getActivityLogs);

/**
 * @route   GET /api/admin/users/:userId/activity-logs
 * @desc    Get user activity history
 * @access  Admin
 */
router.get('/users/:userId/logs', activityLogController.getUserActivityHistory);

/**
 * @route   GET /api/admin/duties/:dutyId/activity-logs
 * @desc    Get duty activity history
 * @access  Admin
 */
router.get('/duties/:dutyId/logs', activityLogController.getDutyActivityHistory);

module.exports = router;
