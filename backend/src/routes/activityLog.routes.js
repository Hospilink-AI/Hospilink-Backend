const express = require('express');
const router = express.Router();
const activityLogController = require('../controllers/activityLog.controller');
const { protect, authorize, requireCapability } = require('../middleware/auth.middleware');

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
 * @access  Admin (super_admin, operations_manager, tech_support read-only)
 */
router.get('/stats', requireCapability('activityLog.view'), activityLogController.getActivityStats);

/**
 * @route   GET /api/admin/activity-logs/critical
 * @desc    Get recent critical activities
 * @access  Admin (super_admin, operations_manager, tech_support read-only)
 */
router.get('/critical', requireCapability('activityLog.view'), activityLogController.getRecentCriticalActivities);

/**
 * @route   GET /api/admin/activity-logs/timeline
 * @desc    Get activity timeline
 * @access  Admin (super_admin, operations_manager, tech_support read-only)
 */
router.get('/timeline', requireCapability('activityLog.view'), activityLogController.getActivityTimeline);

/**
 * @route   GET /api/admin/activity-logs/search
 * @desc    Search activity logs
 * @access  Admin (super_admin, operations_manager, tech_support read-only)
 */
router.get('/search', requireCapability('activityLog.view'), activityLogController.searchActivityLogs);

/**
 * @route   GET /api/admin/activity-logs/export
 * @desc    Export activity logs
 * @access  super_admin only
 */
router.get('/export', requireCapability('activityLog.export'), activityLogController.exportActivityLogs);

/**
 * @route   GET /api/admin/activity-logs/:id
 * @desc    Get activity log by ID
 * @access  Admin (super_admin, operations_manager, tech_support read-only)
 */
router.get('/:id', requireCapability('activityLog.view'), activityLogController.getActivityLogById);

/**
 * @route   GET /api/admin/activity-logs
 * @desc    Get activity logs with filters and pagination
 * @access  Admin (super_admin, operations_manager, tech_support read-only)
 */
router.get('/', requireCapability('activityLog.view'), activityLogController.getActivityLogs);

/**
 * @route   GET /api/admin/users/:userId/activity-logs
 * @desc    Get user activity history
 * @access  Admin (super_admin, operations_manager, tech_support read-only)
 */
router.get('/users/:userId/logs', requireCapability('activityLog.view'), activityLogController.getUserActivityHistory);

/**
 * @route   GET /api/admin/duties/:dutyId/activity-logs
 * @desc    Get duty activity history
 * @access  Admin (super_admin, operations_manager, tech_support read-only)
 */
router.get('/duties/:dutyId/logs', requireCapability('activityLog.view'), activityLogController.getDutyActivityHistory);

module.exports = router;
