const ActivityLog = require('../models/ActivityLog');
const {
    extractIpAddress,
    extractUserAgent,
    categorizeActivity,
    determineActivityStatus,
    sanitizeSensitiveData,
    formatActivityMessage,
    validateActivityLogData,
    buildActivityLogQuery,
    parsePaginationOptions
} = require('../utils/activityLog.helpers');
const { ACTIVITY_STATUSES } = require('../utils/activityLog.constants');
const logger = require('../utils/logger');

/**
 * Activity Log Service
 * Handles all activity logging operations with security and performance optimizations
 */
class ActivityLogService {
    async logActivity(actorData, action, targetData = {}, details = {}, req = null, options = {}) {
        try {
            // Validate required data
            const validation = validateActivityLogData({
                actor: actorData,
                action,
                target: targetData
            });
            
            if (!validation.isValid) {
                logger.error('Invalid activity log data:', validation.errors);
                logger.error('Actor data:', actorData);
                logger.error('Action:', action);
                logger.error('Target data:', targetData);
                return null;
            }
            
            // Sanitize sensitive data
            const sanitizedDetails = sanitizeSensitiveData(details);
            const sanitizedMetadata = sanitizeSensitiveData(options.metadata || {});
            
            // Determine category and status
            const category = categorizeActivity(action);
            const status = options.status || determineActivityStatus(action, true);
            
            // Build activity log document
            const activityLogData = {
                timestamp: new Date(),
                actor: {
                    userId: actorData.userId || null,
                    name: actorData.name,
                    role: actorData.role,
                    email: actorData.email || null
                },
                action,
                category,
                target: {
                    type: targetData.type || null,
                    id: targetData.id || null,
                    name: targetData.name || null
                },
                details: sanitizedDetails,
                location: options.location || null,
                ipAddress: req ? extractIpAddress(req) : 'system',
                userAgent: req ? extractUserAgent(req) : 'system',
                status,
                metadata: sanitizedMetadata
            };
            
            // Create activity log
            const activityLog = new ActivityLog(activityLogData);
            await activityLog.save();
            
            // Log to console for debugging (only in development)
            if (process.env.NODE_ENV === 'development') {
                logger.debug(`Activity logged: ${action} by ${actorData.name} (${actorData.role})`);
            }
            
            return activityLog;
        } catch (error) {
            logger.error('Error logging activity:', error);
            // Don't throw error - logging should not break application flow
            return null;
        }
    }


    // Log activity without request object (for system/cron jobs)
    async logSystemActivity(action, details = {}, options = {}) {
        return this.logActivity(
            {
                userId: null,
                name: 'System',
                role: 'system',
                email: null
            },
            action,
            options.target || {},
            details,
            null,
            options
        );
    }


    // Get activity logs with filters and pagination
    async getActivityLogs(filters = {}, paginationOptions = {}) {
        try {
            const query = buildActivityLogQuery(filters);
            const options = parsePaginationOptions(paginationOptions);
            
            const result = await ActivityLog.getFilteredLogs(filters, options);
            
            return {
                success: true,
                data: result
            };
        } catch (error) {
            logger.error('Error fetching activity logs:', error);
            throw new Error('Failed to fetch activity logs');
        }
    }


    // Get activity log by ID
    async getActivityLogById(logId) {
        try {
            const log = await ActivityLog.findById(logId).lean();
            
            if (!log) {
                throw new Error('Activity log not found');
            }
            
            return {
                success: true,
                data: log
            };
        } catch (error) {
            logger.error('Error fetching activity log by ID:', error);
            throw error;
        }
    }


    // Get activity statistics
    async getActivityStats(filters = {}) {
        try {
            const stats = await ActivityLog.getStatistics(filters);
            
            return {
                success: true,
                data: stats
            };
        } catch (error) {
            logger.error('Error fetching activity statistics:', error);
            throw new Error('Failed to fetch activity statistics');
        }
    }


    // Get user activity history
    async getUserActivityHistory(userId, paginationOptions = {}) {
        try {
            const filters = { actorId: userId };
            return this.getActivityLogs(filters, paginationOptions);
        } catch (error) {
            logger.error('Error fetching user activity history:', error);
            throw new Error('Failed to fetch user activity history');
        }
    }


    // Get duty activity history
    async getDutyActivityHistory(dutyId) {
        try {
            const logs = await ActivityLog.find({
                'target.type': 'duty',
                'target.id': dutyId
            })
            .sort({ timestamp: 1 }) // Chronological order
            .lean();
            
            return {
                success: true,
                data: {
                    logs,
                    count: logs.length
                }
            };
        } catch (error) {
            logger.error('Error fetching duty activity history:', error);
            throw new Error('Failed to fetch duty activity history');
        }
    }


    // Search activity logs
    async searchActivityLogs(searchTerm, filters = {}, paginationOptions = {}) {
        try {
            const options = parsePaginationOptions(paginationOptions);
            const query = buildActivityLogQuery(filters);
            
            // Add text search
            if (searchTerm) {
                query.$text = { $search: searchTerm };
            }
            
            const skip = options.skip;
            const limit = options.limit;
            const sort = { [options.sortBy]: options.sortOrder === 'desc' ? -1 : 1 };
            
            const [logs, total] = await Promise.all([
                ActivityLog.find(query)
                    .sort(sort)
                    .limit(limit)
                    .skip(skip)
                    .lean(),
                ActivityLog.countDocuments(query)
            ]);
            
            return {
                success: true,
                data: {
                    logs,
                    pagination: {
                        currentPage: options.page,
                        totalPages: Math.ceil(total / limit),
                        totalLogs: total,
                        limit,
                        hasNextPage: options.page < Math.ceil(total / limit),
                        hasPrevPage: options.page > 1
                    }
                }
            };
        } catch (error) {
            logger.error('Error searching activity logs:', error);
            throw new Error('Failed to search activity logs');
        }
    }


    // Get recent critical activities 
    async getRecentCriticalActivities(limit = 10) {
        try {
            const logs = await ActivityLog.find({
                status: ACTIVITY_STATUSES.CRITICAL
            })
            .sort({ timestamp: -1 })
            .limit(limit)
            .select('timestamp action actor.name actor.role status details location')
            .lean();
            
            return {
                success: true,
                data: {
                    logs,
                    count: logs.length
                }
            };
        } catch (error) {
            logger.error('Error fetching critical activities:', error);
            throw new Error('Failed to fetch critical activities');
        }
    }


    // Get activity timeline (hourly breakdown)
    async getActivityTimeline(filters = {}) {
        try {
            const query = buildActivityLogQuery(filters);
            
            const timeline = await ActivityLog.aggregate([
                { $match: query },
                {
                    $group: {
                        _id: {
                            year: { $year: '$timestamp' },
                            month: { $month: '$timestamp' },
                            day: { $dayOfMonth: '$timestamp' },
                            hour: { $hour: '$timestamp' }
                        },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } },
                {
                    $project: {
                        _id: 0,
                        hour: {
                            $concat: [
                                { $toString: '$_id.hour' },
                                ':00'
                            ]
                        },
                        count: 1
                    }
                }
            ]);
            
            return {
                success: true,
                data: timeline
            };
        } catch (error) {
            logger.error('Error fetching activity timeline:', error);
            throw new Error('Failed to fetch activity timeline');
        }
    }

    
    // Bulk log activities (for batch operations)
    async bulkLogActivities(activities) {
        try {
            if (!Array.isArray(activities) || activities.length === 0) {
                return { success: true, count: 0 };
            }
            
            // Sanitize and prepare all activities
            const sanitizedActivities = activities.map(activity => {
                const sanitizedDetails = sanitizeSensitiveData(activity.details || {});
                const category = categorizeActivity(activity.action);
                const status = activity.status || determineActivityStatus(activity.action, true);
                
                return {
                    timestamp: new Date(),
                    actor: activity.actor,
                    action: activity.action,
                    category,
                    target: activity.target || {},
                    details: sanitizedDetails,
                    location: activity.location || null,
                    ipAddress: activity.ipAddress || 'system',
                    userAgent: activity.userAgent || 'system',
                    status,
                    metadata: activity.metadata || {}
                };
            });
            
            // Bulk insert
            const result = await ActivityLog.insertMany(sanitizedActivities, { ordered: false });
            
            logger.info(`Bulk logged ${result.length} activities`);
            
            return {
                success: true,
                count: result.length
            };
        } catch (error) {
            logger.error('Error bulk logging activities:', error);
            // Return partial success if some inserts succeeded
            return {
                success: false,
                error: error.message,
                count: error.result?.nInserted || 0
            };
        }
    }
}

module.exports = new ActivityLogService();
