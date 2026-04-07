const express = require('express');
const router = express.Router();
const multer = require('multer');
const profileController = require('../controllers/profile.controller');
const { protect, authorize } = require('../middleware/auth.middleware');
const {
    validateMedicalStaffProfile,
    validateHospitalProfile,
    validateProfileUpdate,
    validateLocationPermission,
    validateStaffAvailability
} = require('../middleware/validation.middleware');
const { locationPermissionRateLimit, staffAvailabilityRateLimit } = require('../middleware/rateLimit.middleware');
const upload = require('../middleware/upload.middleware');

// Apply protection to all profile routes
router.use(protect);

// Get current user profile
router.get('/me', profileController.getMyProfile);

// Update current user profile
router.put('/me', validateProfileUpdate, profileController.updateMyProfile);

// Check profile completion status
router.get('/status', profileController.checkProfileStatus);

// Create medical staff profile (only for staff role)
router.post('/medical-staff',
    authorize('staff'),
    validateMedicalStaffProfile,
    profileController.createMedicalStaffProfile
);

// Check location permission on first visit
router.post('/check-location-permission',
    locationPermissionRateLimit,
    validateLocationPermission,
    authorize('staff'),
    profileController.checkLocationPermission
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
    validateStaffAvailability,
    profileController.toggleMedicalStaffAvailability
);


// Get nearby available staff for hospital map dashboard
router.get('/nearby-staff',
    authorize('hospital'),
    profileController.getNearbyStaff
);

//upload profile pic
router.post(
    '/profile-picture',
    protect,
    upload.single('profilePicture'),
    profileController.uploadProfilePicture
);

// Delete profile picture
router.delete(
    '/delete-picture',
    protect, // Add authentication
    profileController.deleteProfilePicture
);

module.exports = router;