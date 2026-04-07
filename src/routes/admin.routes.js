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
    validateDutyHistoryQuery
} = require('../middleware/admin.middleware');

const { validateDutyCreation } = require('../middleware/validation.middleware');

// Public admin auth routes
router.post('/signin', validateAdminSignin, adminController.adminSignin);
router.post('/signin/verify-otp', validateAdminOTP, adminController.adminVerifyOTP);
router.post('/signin/resend-otp', validateAdminResendOTP, adminController.adminResendOTP);


// Protected admin routes 
router.use(protect);
router.use(authorize('admin'));


router.get('/profile', adminController.getAdminProfile);

//Hospital Management endpoints
router.get('/hospitals-list', adminController.getHospitalSimpleList);
router.get('/hospitals', adminController.listHospitals);
router.get('/hospitals/:hospitalId', adminController.getHospitalDetail);
router.patch('/hospitals/:hospitalId/verify', adminController.verifyHospital);
router.patch('/hospitals/:hospitalId/reject', adminController.rejectHospital);

//dashboard api's
router.post('/create-duty', validateDutyCreation, adminController.createDutyForHospital);
router.get('/dashboard-stats', adminController.getDashboardStats);
router.get('/staff-stats', adminController.getStaffStatistics);


//Medical Staff Management endpoints
router.get('/medical-staff/stats', adminController.getMedicalStaffStats);
router.get('/medical-staff/:staffId', adminController.getMedicalStaffDetail);
router.get('/medical-staff', adminController.getMedicalStaffList);
router.patch('/medical-staff/:staffId/verify', adminController.verifyMedicalStaff);
router.patch('/medical-staff/:staffId/reject', adminController.rejectMedicalStaff);

router.get('/nearby-staff', validateNearbyStaffQuery, adminController.getNearbyAvailableStaff);

router.get('/active-duties', validateActiveDutiesQuery, adminController.getActiveDuties);

router.get('/duty-route-map/:dutyId', validateDutyRouteMap, adminController.getDutyRouteMap);

// Overnight duties and duty history
router.get('/overnight-duties', validateOvernightDutiesQuery, adminController.getOvernightDuties);
router.get('/duty-history', validateDutyHistoryQuery, adminController.getDutyHistory);

//get profile of admin
router.get('/profile', adminController.getAdminProfile);
router.post('/flush-sessions', adminController.flushUserSessions);

// Document verification routes
router.get('/documents/stats', adminController.getDocumentStats);
router.get('/documents', adminController.getAllDocuments);
router.put('/documents/:documentId/verify', adminController.verifyDocument);
router.put('/documents/:documentId/reject', adminController.rejectDocument);

module.exports = router;
