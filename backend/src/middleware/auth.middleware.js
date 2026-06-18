const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const { UnauthorizedError, ForbiddenError, asyncHandler } = require('./error.middleware');
const cacheService = require('../services/cache.service');
const logger = require('../utils/logger');


exports.protect = asyncHandler(async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        throw new UnauthorizedError('Access denied. No token provided.');
    }

    // Fail-closed: if Redis is unavailable, deny access rather than risk accepting a blacklisted token
    try {
        const isBlacklisted = await cacheService.getStrict(`blacklist:${token}`);
        if (isBlacklisted) {
            throw new UnauthorizedError('Token has been invalidated. Please login again.');
        }
    } catch (err) {
        if (err instanceof UnauthorizedError) throw err;
        throw new UnauthorizedError('Authentication service unavailable. Please try again.');
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Check cache for user session
        const sessionKey = `session:${decoded.id}`;
        const cachedSession = await cacheService.get(sessionKey);

        if (cachedSession) {
            // Normalize: ensure both _id and id are available
            req.user = { ...cachedSession, _id: cachedSession._id || cachedSession.id };
            return next();
        }

        // Fallback to database
        const user = await User.findById(decoded.id);
        if (!user) {
            throw new UnauthorizedError('User not found');
        }

        // Cache session for future requests
        await cacheService.set(sessionKey, {
            _id: user._id,
            id: user._id,
            email: user.email,
            role: user.role,
            name: user.name
        }, 86400);

        req.user = user;
        next();
    } catch (error) {
        throw new UnauthorizedError('Invalid token');
    }
});

exports.checkSuspension = asyncHandler(async (req, res, next) => {
    const { role, _id } = req.user;

    // Only applies to hospital and staff
    if (role !== 'hospital' && role !== 'staff') {
        return next();
    }

    const cacheKey = `suspension:${role}:${_id}`;

    let suspensionData = await cacheService.get(cacheKey);

    if (!suspensionData) {

        const Model =
            role === 'hospital'
                ? Hospital
                : MedicalStaff;

        const profile = await Model.findOne({ user: _id })
            .select('isSuspended suspensionReason')
            .lean();

        // Let existing profile validation middleware handle missing profiles
        if (!profile) {
            return next();
        }

        suspensionData = {
            isSuspended: profile.isSuspended || false,
            suspensionReason: profile.suspensionReason || null
        };

        await cacheService.set(
            cacheKey,
            suspensionData,
            300
        );

        logger.debug(
            `Suspension cache set for ${role} user ${_id}: isSuspended=${suspensionData.isSuspended}`
        );
    }

    if (suspensionData.isSuspended) {
        const message = suspensionData.suspensionReason
            ? `Your account has been suspended. Reason: ${suspensionData.suspensionReason}. Please contact support for assistance.`
            : 'Your account has been suspended. Please contact support for assistance.';

        throw new ForbiddenError(message);
    }

    next();
});

exports.authorize = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return next(new ForbiddenError("You don't have permission to do that."));
        }
        next();
    };
};

/**
 * checkSuspension — runs after protect(), before any feature-level middleware.
 * Blocks suspended hospital and staff accounts with a clear 403 message.
 * Admin and candidate roles are never blocked by this check.
 */
exports.checkSuspension = asyncHandler(async (req, res, next) => {
    const role = req.user.role;

    // Only applies to hospital and staff
    if (role !== 'hospital' && role !== 'staff') {
        return next();
    }

    const userId = req.user._id || req.user.id;
    const cacheKey = `suspension:${role}:${userId}`;

    let suspensionData = await cacheService.get(cacheKey);

    if (!suspensionData) {
        // Cache miss — query the profile model directly
        const Model = role === 'hospital' ? Hospital : MedicalStaff;
        const profile = await Model.findOne({ user: userId })
            .select('isSuspended suspensionReason')
            .lean();

        if (!profile) {
            // Profile not yet created — let downstream middleware handle it
            return next();
        }

        suspensionData = {
            isSuspended: profile.isSuspended || false,
            suspensionReason: profile.suspensionReason || null
        };

        // Cache for 5 minutes (same TTL as verification cache)
        await cacheService.set(cacheKey, suspensionData, 300);
        logger.debug(`Suspension cache set for ${role} user ${userId}: isSuspended=${suspensionData.isSuspended}`);
    }

    if (suspensionData.isSuspended) {
        const message = suspensionData.suspensionReason
            ? `Your account has been suspended. Reason: ${suspensionData.suspensionReason}. Please contact support for assistance.`
            : 'Your account has been suspended. Please contact support for assistance.';

        throw new ForbiddenError(message);
    }

    next();
});

