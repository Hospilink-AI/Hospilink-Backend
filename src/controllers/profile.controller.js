const ProfileService = require('../services/profile.service');
const { asyncHandler } = require('../middleware/error.middleware');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');

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
                { hospitalName: result.profile.hospitalLegalName, location: result.profile.location },
                req
            ).catch(err => console.error('Error logging profile creation:', err));
        }

        res.status(201).json({
            success: true,
            ...result
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

            res.status(400).json({
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
        const { radius = 5 } = req.query; // Default 5km radius

        const result = await ProfileService.getNearbyAvailableStaff(hospitalUserId, parseFloat(radius));

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

}

module.exports = new ProfileController();