const jwt = require('jsonwebtoken');
const User = require('../models/User');
const MedicalStaff = require('../models/MedicalStaff');
const logger = require('../utils/logger');
const signOut = require('../services/signOut.service');

// Fields the agent reads from the user; same account rules as the backend
const USER_FIELDS = '_id name role adminSubRole isActive deletion';

/**
 * Why this user can't use the agent, or null. Mirrors the backend sign-in:
 * deleted accounts, accounts scheduled for deletion and deactivated admins
 * are refused.
 */
function accountRefusal(user) {
    if (!user || user.deletion?.completedAt) {
        return { status: 401, code: 'USER_NOT_FOUND', message: 'User not found. Please login again.' };
    }
    if (user.deletion?.requestedAt) {
        return { status: 403, code: 'ACCOUNT_SCHEDULED_FOR_DELETION', message: 'This account is scheduled for deletion. Sign in again to keep it.' };
    }
    if (user.role === 'admin' && user.isActive === false) {
        return { status: 403, code: 'ACCOUNT_DEACTIVATED', message: 'This admin account has been deactivated.' };
    }
    return null;
}

/**
 * Protect agent routes - require valid JWT token
 */
const protect = async (req, res, next) => {
    let token;

    // Get token from header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        logger.warn('Agent access denied - no token provided', { 
            ip: req.ip, 
            userAgent: req.get('User-Agent'),
            path: req.path 
        });
        
        return res.status(401).json({
            status: 'error',
            code: 'UNAUTHORIZED',
            message: 'Access denied. Authentication token required.'
        });
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Signed out on the backend: refused here too
        let signedOut;
        try {
            signedOut = await signOut.isSignedOut(token);
        } catch (err) {
            logger.error('Agent sign-out check unavailable', { error: err.message });
            return res.status(503).json({
                status: 'error',
                code: 'AUTH_UNAVAILABLE',
                message: 'Authentication service unavailable. Please try again.'
            });
        }
        if (signedOut) {
            return res.status(401).json({
                status: 'error',
                code: 'TOKEN_INVALIDATED',
                message: 'Token has been invalidated. Please login again.'
            });
        }

        // Get user from token
        const user = await User.findById(decoded.id).select(USER_FIELDS).lean();
        const refusal = accountRefusal(user);
        if (refusal) {
            logger.warn('Agent access denied', {
                userId: decoded.id,
                code: refusal.code,
                ip: req.ip
            });

            return res.status(refusal.status).json({
                status: 'error',
                code: refusal.code,
                message: refusal.message
            });
        }

        // Attach user to request
        req.user = user;
        next();

    } catch (error) {
        logger.warn('Agent access denied - invalid token', {
            error: error.message,
            errorName: error.name,
            jwtSecretSet: !!process.env.JWT_SECRET,
            ip: req.ip
        });

        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                status: 'error',
                code: 'TOKEN_EXPIRED',
                message: 'Authentication token has expired. Please login again.'
            });
        }

        return res.status(401).json({
            status: 'error',
            code: 'INVALID_TOKEN',
            message: 'Invalid authentication token. Please login again.'
        });
    }
};

/**
 * Ensure user is medical staff
 */
const requireMedicalStaff = async (req, res, next) => {
    try {
        // Check if user role is 'staff'
        if (req.user.role !== 'staff') {
            logger.warn('Agent access denied - not medical staff', { 
                userId: req.user._id,
                userRole: req.user.role,
                ip: req.ip 
            });
            
            return res.status(403).json({
                status: 'error',
                code: 'FORBIDDEN',
                message: 'Access denied. This service is only available to medical staff.'
            });
        }

        // Get medical staff profile
        const medicalStaff = await MedicalStaff.findOne({ user: req.user._id });
        if (!medicalStaff) {
            logger.warn('Agent access denied - medical staff profile not found', { 
                userId: req.user._id,
                ip: req.ip 
            });
            
            return res.status(403).json({
                status: 'error',
                code: 'PROFILE_INCOMPLETE',
                message: 'Medical staff profile not found. Please complete your profile setup.'
            });
        }

        // Check if profile is complete
        if (!medicalStaff.isProfileComplete) {
            return res.status(403).json({
                status: 'error',
                code: 'PROFILE_INCOMPLETE',
                message: 'Please complete your medical staff profile to access job search.'
            });
        }

        // Attach medical staff profile to request
        req.medicalStaff = medicalStaff;
        
        // No name or address in logs
        logger.info('Agent access granted', {
            userId: req.user._id,
            staffId: medicalStaff._id,
            role: medicalStaff.jobRole
        });

        next();

    } catch (error) {
        logger.error('Medical staff verification failed', { 
            error: error.message,
            userId: req.user._id 
        });
        
        return res.status(500).json({
            status: 'error',
            code: 'VERIFICATION_ERROR',
            message: 'Failed to verify medical staff status. Please try again.'
        });
    }
};

/**
 * Super Admin only: destructive maintenance such as clearing every opening
 */
const requireSuperAdmin = (req, res, next) => {
    if (req.user?.role === 'admin' && req.user.adminSubRole === 'super_admin') {
        return next();
    }
    logger.warn('Agent admin action refused', { userId: req.user?._id, userRole: req.user?.role, path: req.path });
    return res.status(403).json({
        status: 'error',
        code: 'FORBIDDEN',
        message: 'Only a Super Admin can do this.'
    });
};

const authenticateSuperAdmin = [protect, requireSuperAdmin];

/**
 * Combined middleware for agent authentication
 * Ensures user is authenticated AND is medical staff
 */
const authenticateMedicalStaff = [protect, requireMedicalStaff];

/**
 * Optional authentication - for endpoints that can work with or without auth
 */
const optionalAuth = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const signedOut = await signOut.isSignedOut(token);
            const user = signedOut ? null : await User.findById(decoded.id).select(USER_FIELDS).lean();

            if (user && !accountRefusal(user) && user.role === 'staff') {
                const medicalStaff = await MedicalStaff.findOne({ user: user._id });
                req.user = user;
                req.medicalStaff = medicalStaff;
            }
        } catch (error) {
            // Ignore auth errors for optional auth
        }
    }

    next();
};

module.exports = {
    accountRefusal,
    requireSuperAdmin,
    authenticateSuperAdmin,
    protect,
    requireMedicalStaff,
    authenticateMedicalStaff,
    optionalAuth
};