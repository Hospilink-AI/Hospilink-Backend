const ProfileService = require('../services/profile.service');
const { asyncHandler, AppError, ValidationError } = require('../middleware/error.middleware');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const OTPService = require('../services/otp.service');
const SMSService = require('../services/sms.service');
const cacheService = require('../services/cache.service');
const logger = require('../utils/logger');


// Maps Twilio SMS error codes to user-facing errors.
// Reference: https://www.twilio.com/docs/api/errors
const mapTwilioError = (err) => {
    switch (err.code) {
        case 21211: // Invalid 'To' Phone Number
        case 21614: // 'To' number is not a valid mobile number
            return new ValidationError('Invalid phone number. Please check and try again.');
        case 21608: // Trial account — 'To' number not verified with Twilio
            return new ValidationError('This phone number is not verified for SMS in test mode. Please contact support.');
        case 21408: // Permission to send SMS not enabled for this region
        case 21610: // Recipient has opted out (replied STOP)
            return new AppError('SMS could not be delivered to this number. Please contact support.', 422);
        case 20003: // Authentication error (bad Account SID / Auth Token)
        case 20404:
            return new AppError('SMS service is temporarily unavailable. Please try again later.', 503);
        default:
            return new AppError('Failed to send OTP. Please try again later.', 503);
    }
};



class ProfileController {
    // Create medical staff profile
    createMedicalStaffProfile = asyncHandler(async (req, res) => {
        const userId = req.user.id;
        const profileData = req.body;

        const result = await ProfileService.createMedicalStaffProfile(userId, profileData);

        // Log profile creation activity
        if (result.profile) {
            const actor = {
                userId: userId,
                name: result.profile.fullName || req.user.name,
                role: 'staff',
                email: req.user.email
            };
            
            activityLogEmitter.emitUserActivity(
                ACTIVITY_ACTIONS.PROFILE_CREATED,
                req.user,
                actor,
                { jobRole: result.profile.jobRole, city: result.profile.city },
                req
            ).catch(err => console.error('Error logging profile creation:', err));
        }

        res.status(201).json({
            success: true,
            ...result
        });
    });


    // Create hospital profile
    createHospitalProfile = asyncHandler(async (req, res) => {
        const userId = req.user.id;
        const profileData = req.body;

        const result = await ProfileService.createHospitalProfile(userId, profileData);

        // Log profile creation activity
        if (result.profile) {
            const actor = {
                userId: userId,
                name: result.profile.hospitalLegalName || req.user.name,
                role: 'hospital',
                email: req.user.email
            };
            
            activityLogEmitter.emitUserActivity(
                ACTIVITY_ACTIONS.PROFILE_CREATED,
                req.user,
                actor,
                { hospitalName: result.profile.hospitalLegalName, city: result.profile.city, state: result.profile.state },
                req
            ).catch(err => console.error('Error logging profile creation:', err));
        }

        res.status(201).json({
            success: true,
            ...result
        });
    });




    // Send OTP to phone number — called when user clicks the "Verify" button on the form
    sendPhoneOTP = asyncHandler(async (req, res) => {
        const userId = req.user.id;
        const { phoneNumber } = req.body;

        const normalizedPhone = SMSService.normalizePhone(phoneNumber);

        const otp = OTPService.generateOTP();
        const otpExpiry = OTPService.getOTPExpiry();

        // Persist OTP before sending — if Redis is down, fail fast instead of
        // sending a paid SMS for an OTP that can never be verified.
        const stored = await cacheService.setPhoneOTP(normalizedPhone, { code: otp, expiresAt: otpExpiry }, 600);
        if (!stored) {
            throw new AppError('Unable to process OTP request right now. Please try again.', 503);
        }

        // Awaited (not fire-and-forget): SMS costs money and failures here are
        // usually permanent (bad number, unverified trial number, region blocked),
        // so the user must be told immediately instead of waiting for an SMS that never arrives.
        try {
            await SMSService.sendOTPSMS(phoneNumber, otp, req.user.name);
        } catch (err) {
            logger.error(`Failed to send phone OTP to ${normalizedPhone} for user ${userId}: ${err.message}`);
            throw mapTwilioError(err);
        }

        res.status(200).json({
            success: true,
            message: 'OTP sent to your mobile number'
        });
    });


    

    // Verify the OTP entered by the user — called when user clicks "Verify OTP"
    verifyPhoneOTP = asyncHandler(async (req, res) => {
        const userId = req.user.id;
        const { phoneNumber, otp } = req.body;

        const normalizedPhone = SMSService.normalizePhone(phoneNumber);

        // getPhoneOTP uses getStrict — a Redis connection error throws here instead
        // of being treated as "no OTP found" (which would read as wrong/expired OTP).
        let otpData;
        try {
            otpData = await cacheService.getPhoneOTP(normalizedPhone);
        } catch (err) {
            logger.error(`Redis error reading phone OTP for ${normalizedPhone}: ${err.message}`);
            throw new AppError('Unable to verify OTP right now. Please try again.', 503);
        }

        if (!otpData || otpData.code !== otp || new Date(otpData.expiresAt) < new Date()) {
            // verifyPhoneOtpRateLimit allows 3 attempts per 15 minutes; req.rateLimit.remaining
            // (set by that middleware) tells us how many attempts are left after this one.
            const attemptsRemaining = req.rateLimit ? Math.max(req.rateLimit.remaining, 0) : 0;

            const message = attemptsRemaining > 0
                ? `Invalid or expired OTP. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} remaining.`
                : 'Invalid or expired OTP. No attempts remaining. Please request a new OTP.';

            return res.status(401).json({
                success: false,
                message,
                attemptsRemaining
            });
        }

        // Consume OTP immediately — one-time use
        await cacheService.deletePhoneOTP(normalizedPhone);

        // Mark this phone as verified for this user; expires in 30 minutes
        // (user must complete and submit the profile form within that window).
        // If this write fails, profile creation would later reject with "not verified"
        // despite this endpoint returning success — so fail loudly here instead.
        const verified = await cacheService.setPhoneVerified(userId, normalizedPhone, 1800);
        if (!verified) {
            throw new AppError('Verification could not be completed. Please try again.', 503);
        }

        res.status(200).json({
            success: true,
            message: 'Phone number verified successfully'
        });
    });


    // Get current user profile
    getMyProfile = asyncHandler(async (req, res) => {
        const userId = req.user.id;

        const result = await ProfileService.getUserProfile(userId);

        res.status(200).json({
            success: true,
            ...result
        });
    });


    // Update current user profile
    updateMyProfile = asyncHandler(async (req, res) => {
        const userId = req.user.id;
        const updateData = req.body;

        const result = await ProfileService.updateUserProfile(userId, updateData);

        // Log profile update activity
        const actor = {
            userId: userId,
            name: req.user.name,
            role: req.user.role,
            email: req.user.email
        };
        
        activityLogEmitter.emitUserActivity(
            ACTIVITY_ACTIONS.PROFILE_UPDATED,
            req.user,
            actor,
            { fieldsUpdated: Object.keys(updateData) },
            req
        ).catch(err => console.error('Error logging profile update:', err));

        res.status(200).json({
            success: true,
            ...result
        });
    });


    // Check profile completion status
    checkProfileStatus = asyncHandler(async (req, res) => {
        const userId = req.user.id;

        const result = await ProfileService.checkProfileCompletion(userId);

        res.status(200).json({
            success: true,
            ...result
        });
    });


    // Get available services list for hospitals
    getAvailableServices = asyncHandler(async (req, res) => {
        const services = [
            'Emergency Care',
            'General Surgery',
            'Cardiology',
            'Neurology',
            'Orthopedics',
            'Pediatrics',
            'Obstetrics & Gynecology',
            'Internal Medicine',
            'Radiology',
            'Laboratory Services',
            'Pharmacy',
            'Physical Therapy',
            'Mental Health',
            'Oncology',
            'Dermatology',
            'Ophthalmology',
            'ENT (Ear, Nose, Throat)',
            'Urology',
            'Gastroenterology',
            'Pulmonology'
        ];

        res.status(200).json({
            success: true,
            services
        });
    });


    // toggle medical staff availability status
    toggleMedicalStaffAvailability = asyncHandler(async (req, res) => {
        const userId = req.user.id;
        const { isAvailable } = req.body;

        // Performance monitoring
        const startTime = Date.now();

        try {
            const result = await ProfileService.toggleMedicalStaffAvailability(userId, isAvailable);

            const responseTime = Date.now() - startTime;

            // Log performance metrics for monitoring
            console.log(`Staff availability toggle for user ${userId}: ${responseTime}ms`);

            // Set appropriate cache headers
            res.set({
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'X-Response-Time': responseTime
            });

            res.status(200).json({
                success: true,
                ...result,
                responseTime: responseTime,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            const responseTime = Date.now() - startTime;
            console.error(`Staff availability toggle failed for user ${userId}: ${responseTime}ms, error: ${error.message}`);

            res.status(error.statusCode || 500).json({
                success: false,
                message: error.message,
                responseTime: responseTime,
                timestamp: new Date().toISOString()
            });
        }
    });


    // Get nearby available staff for hospital map dashboard
    getNearbyStaff = asyncHandler(async (req, res) => {
        const hospitalUserId = req.user.id;
        const { radius = 5, role } = req.query; // Default 5km radius, optional role

        const result = await ProfileService.getNearbyAvailableStaff(
            hospitalUserId, 
            parseFloat(radius), 
            role || null
        );

        res.status(200).json({
            success: true,
            ...result
        });
    });



    // Upload profile picture
    uploadProfilePicture = asyncHandler(async (req, res) => {
        // Validate file exists
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded. Please select an image file.'
            });
        }

        const userId = req.user.id;
        const result = await ProfileService.uploadProfilePicture(userId, req.file);

        res.status(200).json(result);
    });


    // Delete profile picture
    deleteProfilePicture = asyncHandler(async (req, res) => {
        const userId = req.user.id;
        const result = await ProfileService.deleteProfilePicture(userId);

        res.status(200).json(result);
    });
    // Add skills
    addSkills = asyncHandler(async (req, res) => {
        const userId = req.user.id;
        const { skills } = req.body;

        const result = await ProfileService.addSkills(userId, skills);

        res.status(200).json(result);
    });


    // Get skills
    getSkills = asyncHandler(async (req, res) => {
        const userId = req.user.id;

        const result = await ProfileService.getSkills(userId);

        res.status(200).json(result);
    });


    // Update skills
    updateSkills = asyncHandler(async (req, res) => {
        const userId = req.user.id;
        const { skills } = req.body;

        const result = await ProfileService.updateSkills(userId, skills);

        res.status(200).json(result);
    });

}

module.exports = new ProfileController();