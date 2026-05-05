const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const { ForbiddenError, asyncHandler } = require('./error.middleware');
const cacheService = require('../services/cache.service');
const CacheInvalidationService = require('../services/cacheInvalidation.service');
const logger = require('../utils/logger');


// hospital user role 
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


// staff user role 
// Middleware to check staff verification status AND availability
exports.requireStaffVerificationandisAvailable = asyncHandler(async (req, res, next) => {
    // Only apply to staff users
    if (req.user.role !== 'staff') {
        return next();
    }

    const cacheKey = `staff_verification:${req.user._id}`;
    let staffData = await cacheService.get(cacheKey);

    if (!staffData) {
        // Cache miss - fetch from database
        const staff = await MedicalStaff.findOne({ user: req.user._id })
            .select('verificationStatus rejectionReason isAvailable')
            .lean(); // lean() for better performance

        if (!staff) {
            throw new ForbiddenError('Staff profile not found. Please complete your registration.');
        }

        staffData = {
            verificationStatus: staff.verificationStatus,
            rejectionReason: staff.rejectionReason,
            isAvailable: staff.isAvailable
        };

        // Cache for 5 minutes (300 seconds)
        await cacheService.set(cacheKey, staffData, 300);
        
        logger.debug(`Cache set for staff user ${req.user._id}: ${staffData.verificationStatus}, available: ${staffData.isAvailable}`);
    }

    // Check verification status first
    switch (staffData.verificationStatus) {
        case 'verified':
            // Staff is verified - NOW check availability
            if (!staffData.isAvailable) {
                throw new ForbiddenError(
                    'Your availability is currently OFF. ' +
                    'Turn ON your availability to view and accept duties.'
                );
            }
            // Staff is verified AND available - allow access
            req.staffVerification = staffData;
            return next();

        case 'pending':
            throw new ForbiddenError(
                'Your staff registration is pending verification. ' +
                'You cannot access this feature until your profile is verified by our admin team. ' +
                'Please check your email for updates.'
            );

        case 'rejected':
            const rejectionMsg = staffData.rejectionReason
                ? `Your staff registration has been rejected. Reason: ${staffData.rejectionReason}. ` +
                  'Please contact support or update your profile and resubmit for verification.'
                : 'Your staff registration has been rejected. Please contact support for assistance.';
            
            throw new ForbiddenError(rejectionMsg);

        default:
            throw new ForbiddenError('Invalid staff verification status. Please contact support.');
    }
});


// Middleware to check if staff is verified (strict)
exports.requireVerifiedStaff = asyncHandler(async (req, res, next) => {
    if (req.user.role !== 'staff') {
        return next();
    }

    const cacheKey = `staff_verification:${req.user._id}`;
    let verificationStatus = await cacheService.get(cacheKey);

    if (!verificationStatus) {
        const staff = await MedicalStaff.findOne({ user: req.user._id })
            .select('verificationStatus')
            .lean();

        if (!staff) {
            throw new ForbiddenError('Staff profile not found. Please complete your registration.');
        }

        verificationStatus = { status: staff.verificationStatus };
        await cacheService.set(cacheKey, verificationStatus, 300);
    }

    if (verificationStatus.status !== 'verified') {
        throw new ForbiddenError(
            'This feature requires a verified staff account. ' +
            'Please complete the verification process to access this functionality.'
        );
    }

    req.staffVerification = verificationStatus;
    next();
});

// Cache invalidation helpers for staff
exports.invalidateStaffVerificationCache = async (userId) => {
    logger.warn('Deprecated method called. Use CacheInvalidationService.invalidateStaffVerificationCache instead');
    return await CacheInvalidationService.invalidateStaffVerificationCache(userId);
};

exports.refreshStaffVerificationCache = async (userId) => {
    logger.warn('Deprecated method called. Use CacheInvalidationService.refreshStaffVerificationCache instead');
    return await CacheInvalidationService.refreshStaffVerificationCache(userId);
};





// Middleware to check only verification status (for availability toggle route)
exports.requireVerifiedStaffOnly = asyncHandler(async (req, res, next) => {
    // Only apply to staff users
    if (req.user.role !== 'staff') {
        return next();
    }

    const cacheKey = `staff_verification:${req.user._id}`;
    let staffData = await cacheService.get(cacheKey);

    if (!staffData) {
        // Cache miss - fetch from database
        const staff = await MedicalStaff.findOne({ user: req.user._id })
            .select('verificationStatus rejectionReason')
            .lean();

        if (!staff) {
            throw new ForbiddenError('Staff profile not found. Please complete your registration.');
        }

        staffData = {
            verificationStatus: staff.verificationStatus,
            rejectionReason: staff.rejectionReason
        };

        // Cache for 5 minutes (300 seconds)
        await cacheService.set(cacheKey, staffData, 300);
        
        logger.debug(`Cache set for staff user ${req.user._id}: ${staffData.verificationStatus}`);
    }

    // Check verification status only (NOT availability)
    switch (staffData.verificationStatus) {
        case 'verified':
            // Staff is verified - allow access to toggle availability
            req.staffVerification = staffData;
            return next();

        case 'pending':
            throw new ForbiddenError(
                'Your staff registration is pending verification. ' +
                'You cannot toggle availability until your profile is verified by our admin team. ' +
                'Please check your email for updates.'
            );

        case 'rejected':
            const rejectionMsg = staffData.rejectionReason
                ? `Your staff registration has been rejected. Reason: ${staffData.rejectionReason}. ` +
                  'Please contact support or update your profile and resubmit for verification.'
                : 'Your staff registration has been rejected. Please contact support for assistance.';
            
            throw new ForbiddenError(rejectionMsg);

        default:
            throw new ForbiddenError('Invalid staff verification status. Please contact support.');
    }
});