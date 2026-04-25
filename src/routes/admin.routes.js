const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth.middleware');
const adminController = require('../controllers/admin.controller');
const {
    validateStaffDutyReportQuery,
    validateNearbyStaffQuery,
    validateAdminSignin,
    validateAdminOTP,
    validateAdminResendOTP,
    validateActiveDutiesQuery,
    validateDutyRouteMap,
    validateOvernightDutiesQuery,
    validateDutyHistoryQuery,
    validateHospitalSimpleListQuery,
    validateHospitalListQuery,
    validateMedicalStaffListQuery,
    validateDocumentsListQuery,
    validateObjectId,
    validateRejectionReason
} = require('../middleware/admin.middleware');

const { validateDutyCreation } = require('../middleware/validation.middleware');

const { 
    authRateLimit, 
    otpRateLimit,
    generalRateLimit 
} = require('../middleware/rateLimit.middleware');


// Public admin auth routes
// Public admin auth routes
router.post('/signin', authRateLimit, validateAdminSignin, adminController.adminSignin);
router.post('/signin/verify-otp', otpRateLimit, validateAdminOTP, adminController.adminVerifyOTP);
router.post('/signin/resend-otp', otpRateLimit, validateAdminResendOTP, adminController.adminResendOTP);
router.post('/logout', generalRateLimit, protect, adminController.adminLogout);

// Protected admin routes 
router.use(protect);
router.use(authorize('admin'));


router.get('/profile', adminController.getAdminProfile);

//Hospital Management endpoints
router.get('/hospitals-list', validateHospitalSimpleListQuery, adminController.getHospitalSimpleList);
router.get('/hospitals', validateHospitalListQuery, adminController.listHospitals);
router.get('/hospitals/:hospitalId', validateObjectId('hospitalId'), adminController.getHospitalDetail);
router.patch('/hospitals/:hospitalId/verify', validateObjectId('hospitalId'), adminController.verifyHospital);
router.patch('/hospitals/:hospitalId/reject', validateObjectId('hospitalId'), validateRejectionReason, adminController.rejectHospital);

//dashboard api's
router.post('/create-duty', validateDutyCreation, adminController.createDutyForHospital);
router.get('/dashboard-stats', adminController.getDashboardStats);
router.get('/staff-stats', adminController.getStaffStatistics);


//Medical Staff Management endpoints
router.get('/medical-staff/stats', adminController.getMedicalStaffStats);
router.get('/medical-staff/:staffId', validateObjectId('staffId'), adminController.getMedicalStaffDetail);
router.get('/medical-staff', validateMedicalStaffListQuery, adminController.getMedicalStaffList);
router.patch('/medical-staff/:staffId/verify', validateObjectId('staffId'), adminController.verifyMedicalStaff);
router.patch('/medical-staff/:staffId/reject', validateObjectId('staffId'), validateRejectionReason, adminController.rejectMedicalStaff);

router.get('/nearby-staff', validateNearbyStaffQuery, adminController.getNearbyAvailableStaff);

router.get('/active-duties', validateActiveDutiesQuery, adminController.getActiveDuties);

router.get('/emergency-dashboard', adminController.getEmergencyDashboard);

router.get('/duty-route-map/:dutyId', validateDutyRouteMap, adminController.getDutyRouteMap);

// Overnight duties and duty history
router.get('/overnight-duties', validateOvernightDutiesQuery, adminController.getOvernightDuties);
router.get('/duty-history', validateDutyHistoryQuery, adminController.getDutyHistory);

//get profile of admin
router.get('/profile', adminController.getAdminProfile);
router.post('/flush-sessions', adminController.flushUserSessions);

// Document verification routes
router.get('/documents/stats', adminController.getDocumentStats);
router.get('/documents', validateDocumentsListQuery, adminController.getAllDocuments);
router.put('/documents/:documentId/verify', validateObjectId('documentId'), adminController.verifyDocument);
router.put('/documents/:documentId/reject', validateObjectId('documentId'), validateRejectionReason, adminController.rejectDocument);

module.exports = router;
