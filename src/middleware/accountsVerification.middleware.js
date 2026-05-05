const Hospital = require('../models/Hospital');
const { ForbiddenError, asyncHandler } = require('./error.middleware');
const cacheService = require('../services/cache.service');
const CacheInvalidationService = require('../services/cacheInvalidation.service');
const logger = require('../utils/logger');


// Middleware to check hospital verification status
exports.requireHospitalVerification = asyncHandler(async (req, res, next) => {
    // Only apply to hospital users
    if (req.user.role !== 'hospital') {
        return next();
    }

    const cacheKey = `hospital_verification:${req.user._id}`;
    let verificationStatus = await cacheService.get(cacheKey);

    if (!verificationStatus) {
        // Cache miss - fetch from database
        const hospital = await Hospital.findOne({ user: req.user._id })
            .select('verificationStatus rejectionReason')
            .lean(); // lean() for better performance

        if (!hospital) {
            throw new ForbiddenError('Hospital profile not found. Please complete your registration.');
        }

        verificationStatus = {
            status: hospital.verificationStatus,
            rejectionReason: hospital.rejectionReason
        };

        // Cache for 5 minutes (300 seconds)
        await cacheService.set(cacheKey, verificationStatus, 300);
        
        logger.debug(`Cache set for hospital user ${req.user._id}: ${verificationStatus.status}`);
    }

    // Check verification status
    switch (verificationStatus.status) {
        case 'verified':
            // Hospital is verified - allow access
            req.hospitalVerification = verificationStatus;
            return next();

        case 'pending':
            throw new ForbiddenError(
                'Your hospital registration is pending verification. ' +
                'You cannot access this feature until your profile is verified by our admin team. ' +
                'Please check your email for updates.'
            );

        case 'rejected':
            const rejectionMsg = verificationStatus.rejectionReason
                ? `Your hospital registration has been rejected. Reason: ${verificationStatus.rejectionReason}. ` +
                  'Please contact support or update your profile and resubmit for verification.'
                : 'Your hospital registration has been rejected. Please contact support for assistance.';
            
            throw new ForbiddenError(rejectionMsg);

        default:
            throw new ForbiddenError('Invalid hospital verification status. Please contact support.');
    }
});



// Middleware to check if hospital is verified (strict)
exports.requireVerifiedHospital = asyncHandler(async (req, res, next) => {
    if (req.user.role !== 'hospital') {
        return next();
    }

    const cacheKey = `hospital_verification:${req.user._id}`;
    let verificationStatus = await cacheService.get(cacheKey);

    if (!verificationStatus) {
        const hospital = await Hospital.findOne({ user: req.user._id })
            .select('verificationStatus')
            .lean();

        if (!hospital) {
            throw new ForbiddenError('Hospital profile not found. Please complete your registration.');
        }

        verificationStatus = { status: hospital.verificationStatus };
        await cacheService.set(cacheKey, verificationStatus, 300);
    }

    if (verificationStatus.status !== 'verified') {
        throw new ForbiddenError(
            'This feature requires a verified hospital account. ' +
            'Please complete the verification process to access this functionality.'
        );
    }

    req.hospitalVerification = verificationStatus;
    next();
});


// CacheInvalidationService instead
exports.invalidateHospitalVerificationCache = async (userId) => {
    logger.warn('Deprecated method called. Use CacheInvalidationService.invalidateHospitalVerificationCache instead');
    return await CacheInvalidationService.invalidateHospitalVerificationCache(userId);
};


// refresh Hospital verification cache
exports.refreshHospitalVerificationCache = async (userId) => {
    logger.warn('Deprecated method called. Use CacheInvalidationService.refreshHospitalVerificationCache instead');
    return await CacheInvalidationService.refreshHospitalVerificationCache(userId);
};