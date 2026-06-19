const express = require('express');
const router = express.Router();
const multer = require('multer');
const profileController = require('../controllers/profile.controller');
const dashboardController = require('../controllers/dashboard.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const {
    validateMedicalStaffProfile,
    validateHospitalProfile,
    validateProfileUpdate,
    validateStaffAvailability,
    validateNearbyStaff,
    validateDashboardLocationPermission,
    validateSendPhoneOTP,
    validateVerifyPhoneOTP
} = require('../middleware/validation.middleware');
const { staffAvailabilityRateLimit, phoneOtpRateLimit, verifyPhoneOtpRateLimit } = require('../middleware/rateLimit.middleware');
const upload = require('../middleware/upload.middleware');
const { requireHospitalVerification, requireStaffVerificationandisAvailable, requireVerifiedStaffOnly} = require('../middleware/accountsVerification.middleware');

// Apply protection to all profile routes
router.use(protect);
router.use(checkSuspension);

// Get current user profile
router.get('/me', profileController.getMyProfile);

// Update current user profile
router.put('/me', validateProfileUpdate, profileController.updateMyProfile);

// Check profile completion status
router.get('/status', profileController.checkProfileStatus);

// Send OTP to phone number — user clicks "Verify" button on the profile form
router.post('/send-phone-otp',
    phoneOtpRateLimit,
    validateSendPhoneOTP,
    profileController.sendPhoneOTP
);

// Verify the OTP — user clicks "Verify OTP" after entering the code
router.post('/verify-phone-otp',
    verifyPhoneOtpRateLimit,
    validateVerifyPhoneOTP,
    profileController.verifyPhoneOTP
);

// Create medical staff profile (only for staff role)
router.post('/medical-staff',
    authorize('staff'),
    validateMedicalStaffProfile,
    profileController.createMedicalStaffProfile
);


// Create hospital profile (only for hospital role)
router.post('/hospital',
    authorize('hospital'),
    validateHospitalProfile,
    profileController.createHospitalProfile
);

// Get available services for hospitals
router.get('/services', profileController.getAvailableServices);

// Toggle medical staff availability (only for staff role)
router.patch('/staff-availability',
    staffAvailabilityRateLimit,
    authorize('staff'),
    requireVerifiedStaffOnly, 
    validateStaffAvailability,
    profileController.toggleMedicalStaffAvailability
);


// Get nearby available staff for hospital map dashboard
router.get('/nearby-staff',
    authorize('hospital'),
    requireHospitalVerification, 
    validateNearbyStaff,
    profileController.getNearbyStaff
);

//upload profile pic
router.post(
    '/profile-picture',
    protect,
    upload.single('profilePicture'),
    profileController.uploadProfilePicture
);



// Dashboard location permission routes
router.post('/dashboard/location-permission',
    authorize('staff'),
    validateDashboardLocationPermission,
    dashboardController.checkDashboardLocationPermission
);

router.get('/dashboard/location-status',
    authorize('staff'),
    dashboardController.getLocationStatus
);



// Delete profile picture
router.delete(
    '/delete-picture',
    protect, // Add authentication
    profileController.deleteProfilePicture
);
// Skills management (staff only)
router.post(
    '/skills',
    authorize('staff'),
    profileController.addSkills
);

router.get(
    '/skills',
    authorize('staff'),
    profileController.getSkills
);

router.patch(
    '/skills',
    authorize('staff'),
    profileController.updateSkills
);

module.exports = router;