const activityLogService = require('../services/activityLog.service');
const { asyncHandler } = require('../middleware/error.middleware');
const { generateActivityLogsPDF } = require('../utils/pdf.puppeteer');
const logger = require('../utils/logger');

/**
 * Activity Log Controller
 * Handles HTTP requests for activity logs (admin only)
 */

/**
 * Get activity logs with filters and pagination
 * GET /api/admin/activity-logs
 */
exports.getActivityLogs = asyncHandler(async (req, res) => {
    const filters = {
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        dateRange: req.query.dateRange,
        category: req.query.category,
        action: req.query.action,
        status: req.query.status,
        actorId: req.query.actorId,
        actorRole: req.query.actorRole,
        targetId: req.query.targetId,
        targetType: req.query.targetType,
        location: req.query.location,
        ipAddress: req.query.ipAddress
    };

    // Remove undefined values
    Object.keys(filters).forEach(key => {
        if (filters[key] === undefined) {
            delete filters[key];
        }
    });

    const paginationOptions = {
        page: req.query.page,
        limit: req.query.limit,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder
    };

    const result = await activityLogService.getActivityLogs(filters, paginationOptions);

    res.status(200).json({
        success: true,
        data: result.data.logs,
        pagination: result.data.pagination,
        filters
    });
});

/**
 * Get activity log by ID
 * GET /api/admin/activity-logs/:id
 */
exports.getActivityLogById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await activityLogService.getActivityLogById(id);

    res.status(200).json({
        success: true,
        data: result.data
    });
});

/**
 * Get activity statistics
 * GET /api/admin/activity-logs/stats
 */
exports.getActivityStats = asyncHandler(async (req, res) => {
    const filters = {
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        dateRange: req.query.dateRange
    };

    // Remove undefined values
    Object.keys(filters).forEach(key => {
        if (filters[key] === undefined) {
            delete filters[key];
        }
    });

    const result = await activityLogService.getActivityStats(filters);

    res.status(200).json({
        success: true,
        data: result.data
    });
});

/**
 * Get user activity history
 * GET /api/admin/users/:userId/activity-logs
 */
exports.getUserActivityHistory = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const paginationOptions = {
        page: req.query.page,
        limit: req.query.limit,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder
    };

    const result = await activityLogService.getUserActivityHistory(userId, paginationOptions);

    res.status(200).json({
        success: true,
        data: result.data.logs,
        pagination: result.data.pagination
    });
});

/**
 * Get duty activity history
 * GET /api/admin/duties/:dutyId/activity-logs
 */
exports.getDutyActivityHistory = asyncHandler(async (req, res) => {
    const { dutyId } = req.params;

    const result = await activityLogService.getDutyActivityHistory(dutyId);

    res.status(200).json({
        success: true,
        data: result.data.logs,
        count: result.data.count
    });
});

/**
 * Search activity logs
 * GET /api/admin/activity-logs/search
 */
exports.searchActivityLogs = asyncHandler(async (req, res) => {
    const searchTerm = req.query.q || req.query.search;

    if (!searchTerm) {
        return res.status(400).json({
            success: false,
            message: 'Search term is required'
        });
    }

    const filters = {
        category: req.query.category,
        action: req.query.action,
        status: req.query.status,
        actorRole: req.query.actorRole
    };

    // Remove undefined values
    Object.keys(filters).forEach(key => {
        if (filters[key] === undefined) {
            delete filters[key];
        }
    });

    const paginationOptions = {
        page: req.query.page,
        limit: req.query.limit,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder
    };

    const result = await activityLogService.searchActivityLogs(searchTerm, filters, paginationOptions);

    res.status(200).json({
        success: true,
        data: result.data.logs,
        pagination: result.data.pagination,
        searchTerm
    });
});

/**
 * Get recent critical activities
 * GET /api/admin/activity-logs/critical
 */
exports.getRecentCriticalActivities = asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit) || 10;

    const result = await activityLogService.getRecentCriticalActivities(limit);

    res.status(200).json({
        success: true,
        data: result.data.logs,
        count: result.data.count
    });
});

/**
 * Get activity timeline
 * GET /api/admin/activity-logs/timeline
 */
exports.getActivityTimeline = asyncHandler(async (req, res) => {
    const filters = {
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        dateRange: req.query.dateRange,
        category: req.query.category
    };

    // Remove undefined values
    Object.keys(filters).forEach(key => {
        if (filters[key] === undefined) {
            delete filters[key];
        }
    });

    const result = await activityLogService.getActivityTimeline(filters);

    res.status(200).json({
        success: true,
        data: result.data
    });
});

/**
 * Export activity logs
 * GET /api/admin/activity-logs/export
 */
exports.exportActivityLogs = asyncHandler(async (req, res) => {
    const format = req.query.format || 'csv';

    if (!['csv', 'json', 'pdf'].includes(format)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid export format. Supported formats: csv, json, pdf'
        });
    }

    const filters = {
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        dateRange: req.query.dateRange,
        category: req.query.category,
        action: req.query.action,
        status: req.query.status
    };

    // Remove undefined values
    Object.keys(filters).forEach(key => {
        if (filters[key] === undefined) {
            delete filters[key];
        }
    });

    // Fetch logs without pagination for export
    const result = await activityLogService.getActivityLogs(filters, { limit: 10000 });

    if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=activity-logs-${Date.now()}.json`);
        return res.status(200).json({
            success: true,
            data: result.data.logs,
            exportedAt: new Date().toISOString(),
            filters
        });
    }

    if (format === 'csv') {
        // Convert to CSV
        const logs = result.data.logs;
        
        if (logs.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No logs found to export'
            });
        }

        // CSV headers
        const headers = [
            'Timestamp',
            'Actor Name',
            'Actor Role',
            'Action',
            'Category',
            'Target Type',
            'Target Name',
            'Location',
            'IP Address',
            'Status'
        ];

        // CSV rows
        const rows = logs.map(log => [
            new Date(log.timestamp).toISOString(),
            log.actor.name,
            log.actor.role,
            log.action,
            log.category,
            log.target?.type || '',
            log.target?.name || '',
            log.location || '',
            log.ipAddress || '',
            log.status
        ]);

        // Build CSV content
        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=activity-logs-${Date.now()}.csv`);
        return res.status(200).send(csvContent);
    }

    if (format === 'pdf') {
        return generateActivityLogsPDF(res, {
            logs: result.data.logs,
            filters,
            exportedAt: new Date().toISOString()
        });
    }
});
