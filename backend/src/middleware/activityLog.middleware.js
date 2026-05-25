const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');

/**
 * Activity Log Middleware
 * Automatically logs certain activities based on routes and actions
 */

/**
 * Log authentication activities
 * Use this middleware on auth routes
 */
const logAuthActivity = (action) => {
    return async (req, res, next) => {
        // Store original send function
        const originalSend = res.send;
        
        // Override send function to capture response
        res.send = function(data) {
            // Restore original send
            res.send = originalSend;
            
            // Check if response was successful
            const responseData = typeof data === 'string' ? JSON.parse(data) : data;
            const success = res.statusCode >= 200 && res.statusCode < 300 && responseData.success !== false;
            
            // Log activity after response
            if (req.user) {
                const actor = {
                    userId: req.user.id || req.user._id,
                    name: req.user.name,
                    role: req.user.role,
                    email: req.user.email
                };
                
                activityLogEmitter.emitUserActivity(
                    action,
                    req.user,
                    actor,
                    { success },
                    req
                ).catch(err => console.error('Error logging auth activity:', err));
            }
            
            // Send response
            return originalSend.call(this, data);
        };
        
        next();
    };
};

/**
 * Log admin actions
 * Use this middleware on admin routes
 */
const logAdminAction = (action, getTargetData) => {
    return async (req, res, next) => {
        // Store original json function
        const originalJson = res.json;
        
        // Override json function to capture response
        res.json = function(data) {
            // Restore original json
            res.json = originalJson;
            
            // Check if response was successful
            const success = res.statusCode >= 200 && res.statusCode < 300 && data.success !== false;
            
            // Log activity after response
            if (success && req.user && req.user.role === 'admin') {
                const admin = {
                    userId: req.user.id || req.user._id,
                    name: req.user.name,
                    role: 'admin',
                    email: req.user.email
                };
                
                // Get target data from request/response
                const targetData = getTargetData ? getTargetData(req, data) : null;
                
                activityLogEmitter.emitAdminActivity(
                    action,
                    targetData,
                    admin,
                    { requestBody: req.body, responseData: data },
                    req
                ).catch(err => console.error('Error logging admin activity:', err));
            }
            
            // Send response
            return originalJson.call(this, data);
        };
        
        next();
    };
};

/**
 * Log security events
 * Use this for failed authentication attempts, suspicious activities
 */
const logSecurityEvent = (action, getDetails) => {
    return async (req, res, next) => {
        const details = getDetails ? getDetails(req) : {};
        
        const actor = req.user ? {
            userId: req.user.id || req.user._id,
            name: req.user.name,
            role: req.user.role,
            email: req.user.email
        } : {
            userId: null,
            name: 'Unknown',
            role: 'system',
            email: req.body?.email || 'unknown'
        };
        
        activityLogEmitter.emitSecurityActivity(
            action,
            actor,
            details,
            req
        ).catch(err => console.error('Error logging security event:', err));
        
        next();
    };
};

/**
 * Extract request metadata
 * Helper function to extract common request information
 */
const extractRequestMetadata = (req) => {
    return {
        method: req.method,
        path: req.path,
        query: req.query,
        body: req.body,
        params: req.params,
        headers: {
            userAgent: req.headers['user-agent'],
            referer: req.headers['referer'],
            origin: req.headers['origin']
        }
    };
};

/**
 * Rate limit exceeded handler
 * Log when rate limit is exceeded
 */
const logRateLimitExceeded = async (req, res, next) => {
    const actor = req.user ? {
        userId: req.user.id || req.user._id,
        name: req.user.name,
        role: req.user.role,
        email: req.user.email
    } : {
        userId: null,
        name: 'Unknown',
        role: 'system',
        email: 'unknown'
    };
    
    await activityLogEmitter.emitSecurityActivity(
        ACTIVITY_ACTIONS.SUSPICIOUS_LOGIN_ATTEMPT,
        actor,
        {
            reason: 'Rate limit exceeded',
            path: req.path,
            method: req.method
        },
        req
    ).catch(err => console.error('Error logging rate limit:', err));
    
    next();
};

/**
 * Unauthorized access handler
 * Log unauthorized access attempts
 */
const logUnauthorizedAccess = async (req, res, next) => {
    const actor = req.user ? {
        userId: req.user.id || req.user._id,
        name: req.user.name,
        role: req.user.role,
        email: req.user.email
    } : {
        userId: null,
        name: 'Unknown',
        role: 'system',
        email: 'unknown'
    };
    
    await activityLogEmitter.emitSecurityActivity(
        ACTIVITY_ACTIONS.UNAUTHORIZED_ACCESS_ATTEMPT,
        actor,
        {
            attemptedPath: req.path,
            method: req.method,
            requiredRole: req.requiredRole || 'unknown'
        },
        req
    ).catch(err => console.error('Error logging unauthorized access:', err));
    
    next();
};

module.exports = {
    logAuthActivity,
    logAdminAction,
    logSecurityEvent,
    extractRequestMetadata,
    logRateLimitExceeded,
    logUnauthorizedAccess
};
