const { 
    ACTION_CATEGORY_MAP, 
    CRITICAL_ACTIONS, 
    ACTIVITY_STATUSES,
    SENSITIVE_FIELDS 
} = require('./activityLog.constants');

/**
 * Activity Log Helper Utilities
 */

/**
 * Extract IP address from request
 * Handles proxies and load balancers
 * @param {Object} req - Express request object
 * @returns {string} IP address
 */
const extractIpAddress = (req) => {
    if (!req) return 'unknown';
    
    // Check for IP from various headers (proxy-aware)
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.headers['x-real-ip'] ||
               req.connection?.remoteAddress ||
               req.socket?.remoteAddress ||
               req.ip ||
               'unknown';
    
    // Remove IPv6 prefix if present
    return ip.replace(/^::ffff:/, '');
};

/**
 * Extract user agent from request
 * @param {Object} req - Express request object
 * @returns {string} User agent
 */
const extractUserAgent = (req) => {
    if (!req) return 'unknown';
    return req.headers['user-agent'] || 'unknown';
};

/**
 * Determine activity category from action
 * @param {string} action - Activity action
 * @returns {string} Category
 */
const categorizeActivity = (action) => {
    return ACTION_CATEGORY_MAP[action] || 'SYSTEM';
};

/**
 * Determine if activity is critical
 * @param {string} action - Activity action
 * @returns {boolean} Is critical
 */
const isCriticalActivity = (action) => {
    return CRITICAL_ACTIONS.includes(action);
};

/**
 * Determine activity status based on action and result
 * @param {string} action - Activity action
 * @param {boolean} success - Whether action succeeded
 * @param {Object} options - Additional options
 * @returns {string} Status
 */
const determineActivityStatus = (action, success = true, options = {}) => {
    // Critical actions always marked as CRITICAL
    if (isCriticalActivity(action)) {
        return ACTIVITY_STATUSES.CRITICAL;
    }
    
    // Failed actions
    if (!success) {
        return ACTIVITY_STATUSES.FAILED;
    }
    
    // Warning conditions
    if (options.isWarning) {
        return ACTIVITY_STATUSES.WARNING;
    }
    
    return ACTIVITY_STATUSES.SUCCESS;
};

/**
 * Sanitize sensitive data from object
 * Recursively removes or masks sensitive fields
 * @param {Object} data - Data to sanitize
 * @param {Array} sensitiveFields - Fields to sanitize
 * @returns {Object} Sanitized data
 */
const sanitizeSensitiveData = (data, sensitiveFields = SENSITIVE_FIELDS) => {
    if (!data || typeof data !== 'object') {
        return data;
    }
    
    const sanitized = Array.isArray(data) ? [...data] : { ...data };
    
    for (const key in sanitized) {
        // Check if field is sensitive
        const isSensitive = sensitiveFields.some(field => 
            key.toLowerCase().includes(field.toLowerCase())
        );
        
        if (isSensitive) {
            sanitized[key] = '[REDACTED]';
        } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
            // Recursively sanitize nested objects
            sanitized[key] = sanitizeSensitiveData(sanitized[key], sensitiveFields);
        }
    }
    
    return sanitized;
};

/**
 * Format activity message for display
 * @param {string} action - Activity action
 * @param {Object} details - Activity details
 * @returns {string} Formatted message
 */
const formatActivityMessage = (action, details = {}) => {
    const messages = {
        // Duty activities
        DUTY_CREATED: `Created duty for ${details.staffRole || 'staff'} at ${details.location || 'hospital'}`,
        DUTY_ACCEPTED: `Accepted duty #${details.dutyId?.slice(-6) || 'unknown'}`,
        DUTY_STARTED: `Started duty #${details.dutyId?.slice(-6) || 'unknown'}`,
        DUTY_IN_PROGRESS: `Duty #${details.dutyId?.slice(-6) || 'unknown'} in progress`,
        DUTY_COMPLETED: `Completed duty #${details.dutyId?.slice(-6) || 'unknown'}`,
        DUTY_CANCELLED: `Cancelled duty #${details.dutyId?.slice(-6) || 'unknown'}`,
        DUTY_EDITED: `Edited duty #${details.dutyId?.slice(-6) || 'unknown'}`,
        EMERGENCY_DUTY_CREATED: `Created EMERGENCY duty for ${details.staffRole || 'staff'}`,
        
        // User activities
        USER_REGISTERED: `New ${details.role || 'user'} registered`,
        USER_LOGIN: `Logged in successfully`,
        USER_LOGOUT: `Logged out`,
        USER_LOGIN_FAILED: `Failed login attempt`,
        PROFILE_CREATED: `Created ${details.role || 'user'} profile`,
        PROFILE_UPDATED: `Updated profile`,
        PASSWORD_CHANGED: `Changed password`,
        EMAIL_VERIFIED: `Verified email address`,
        
        // Document activities
        DOCUMENT_UPLOADED: `Uploaded ${details.documentType || 'document'}`,
        DOCUMENT_VERIFIED: `Verified ${details.documentType || 'document'}`,
        DOCUMENT_REJECTED: `Rejected ${details.documentType || 'document'}`,
        DOCUMENT_DELETED: `Deleted ${details.documentType || 'document'}`,
        
        // Review activities
        REVIEW_SUBMITTED: `Submitted review with ${details.rating || 0} stars`,
        REVIEW_RECEIVED: `Received review with ${details.rating || 0} stars`,
        
        // Admin activities
        ADMIN_LOGIN: `Admin logged in`,
        USER_APPROVED: `Approved user ${details.userName || 'unknown'}`,
        USER_REJECTED: `Rejected user ${details.userName || 'unknown'}`,
        DOCUMENT_VERIFIED_BY_ADMIN: `Admin verified ${details.documentType || 'document'}`,
        
        // Security activities
        SUSPICIOUS_LOGIN_ATTEMPT: `Suspicious login attempt detected`,
        MULTIPLE_FAILED_LOGINS: `Multiple failed login attempts`,
        UNAUTHORIZED_ACCESS_ATTEMPT: `Unauthorized access attempt`,
        
        // System activities
        CRON_JOB_EXECUTED: `Executed cron job: ${details.jobName || 'unknown'}`,
        DUTY_AUTO_COMPLETED: `Auto-completed duty #${details.dutyId?.slice(-6) || 'unknown'}`
    };
    
    return messages[action] || `Performed action: ${action}`;
};

/**
 * Validate activity log data
 * @param {Object} logData - Activity log data
 * @returns {Object} Validation result
 */
const validateActivityLogData = (logData) => {
    const errors = [];
    
    if (!logData.action) {
        errors.push('Action is required');
    }
    
    if (!logData.actor || !logData.actor.name) {
        errors.push('Actor name is required');
    }
    
    if (!logData.actor || !logData.actor.role) {
        errors.push('Actor role is required');
    }
    
    // Only validate target type if target has a valid ID (not null/undefined)
    if (logData.target && logData.target.id && logData.target.id !== null && !logData.target.type) {
        errors.push('Target type is required when target ID is provided');
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
};

/**
 * Parse date string in dd-mm-yyyy format
 * @param {string} dateString - Date in dd-mm-yyyy format
 * @returns {Date|null} Parsed date or null if invalid
 */
const parseDateString = (dateString) => {
    if (!dateString) return null;
    
    // Check if it's dd-mm-yyyy format
    const ddmmyyyyPattern = /^(\d{2})-(\d{2})-(\d{4})$/;
    const match = dateString.match(ddmmyyyyPattern);
    
    if (match) {
        const [, day, month, year] = match;
        // Month is 0-indexed in JavaScript Date
        const date = new Date(year, month - 1, day);
        
        // Validate the date is valid
        if (date.getDate() == day && date.getMonth() == month - 1 && date.getFullYear() == year) {
            return date;
        }
    }
    
    // Fallback to standard Date parsing (ISO format, etc.)
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
};

/**
 * Build activity log query from filters
 * @param {Object} filters - Filter parameters
 * @returns {Object} MongoDB query object
 */
const buildActivityLogQuery = (filters = {}) => {
    const query = {};
    
    // Date range
    if (filters.startDate || filters.endDate) {
        query.timestamp = {};
        if (filters.startDate) {
            const startDate = parseDateString(filters.startDate);
            if (startDate) {
                startDate.setHours(0, 0, 0, 0); // Start of day
                query.timestamp.$gte = startDate;
            }
        }
        if (filters.endDate) {
            const endDate = parseDateString(filters.endDate);
            if (endDate) {
                endDate.setHours(23, 59, 59, 999); // End of day
                query.timestamp.$lte = endDate;
            }
        }
    }
    
    // Predefined date ranges
    if (filters.dateRange) {
        const ranges = {
            today: (() => {
                const date = new Date();
                date.setHours(0, 0, 0, 0);
                return date;
            })(),
            lastweek: (() => {
                const date = new Date();
                date.setDate(date.getDate() - 7);
                date.setHours(0, 0, 0, 0);
                return date;
            })()
        };
        
        if (ranges[filters.dateRange]) {
            query.timestamp = { $gte: ranges[filters.dateRange] };
        }
    }
    
    // Category filter
    if (filters.category) {
        query.category = filters.category;
    }
    
    // Action filter
    if (filters.action) {
        query.action = filters.action;
    }
    
    // Status filter
    if (filters.status) {
        query.status = filters.status;
    }
    
    // Actor filters
    if (filters.actorId) {
        query['actor.userId'] = filters.actorId;
    }
    
    if (filters.actorRole) {
        query['actor.role'] = filters.actorRole;
    }
    
    // Target filters
    if (filters.targetId) {
        query['target.id'] = filters.targetId;
    }
    
    if (filters.targetType) {
        query['target.type'] = filters.targetType;
    }
    
    // Location filter (case-insensitive partial match)
    if (filters.location) {
        query.location = new RegExp(filters.location, 'i');
    }
    
    // IP address filter
    if (filters.ipAddress) {
        query.ipAddress = filters.ipAddress;
    }
    
    return query;
};

/**
 * Parse pagination options
 * @param {Object} options - Pagination options
 * @returns {Object} Parsed options
 */
const parsePaginationOptions = (options = {}) => {
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 50));
    const sortBy = options.sortBy || 'timestamp';
    const sortOrder = options.sortOrder === 'asc' ? 'asc' : 'desc';
    
    return {
        page,
        limit,
        skip: (page - 1) * limit,
        sortBy,
        sortOrder
    };
};

module.exports = {
    extractIpAddress,
    extractUserAgent,
    categorizeActivity,
    isCriticalActivity,
    determineActivityStatus,
    sanitizeSensitiveData,
    formatActivityMessage,
    validateActivityLogData,
    buildActivityLogQuery,
    parsePaginationOptions,
    parseDateString
};
