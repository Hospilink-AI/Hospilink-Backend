const jwt = require('jsonwebtoken');
const User = require('../models/User');
const MedicalStaff = require('../models/MedicalStaff');
const logger = require('../utils/logger');

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
        
        // Get user from token
        const user = await User.findById(decoded.id);
        if (!user) {
            logger.warn('Agent access denied - user not found', { 
                userId: decoded.id,
                ip: req.ip 
            });
            
            return res.status(401).json({
                status: 'error',
                code: 'USER_NOT_FOUND',
                message: 'User not found. Please login again.'
            });
        }

        // Attach user to request
        req.user = user;
        next();

    } catch (error) {
        logger.warn('Agent access denied - invalid token', { 
            error: error.message,
            ip: req.ip 
        });
        
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
        
        logger.info('Agent access granted', { 
            userId: req.user._id,
            staffId: medicalStaff._id,
            name: medicalStaff.fullName,
            role: medicalStaff.jobRole,
            location: `${medicalStaff.city}, ${medicalStaff.area}`
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
            const user = await User.findById(decoded.id);
            
            if (user && user.role === 'staff') {
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
    protect,
    requireMedicalStaff,
    authenticateMedicalStaff,
    optionalAuth
};