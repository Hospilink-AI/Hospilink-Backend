const express = require('express');
const router = express.Router();
const { protect, authorize, requireCapability } = require('../middleware/auth.middleware');
const adminController = require('../controllers/admin.controller');
const adminManagementController = require('../controllers/adminManagement.controller');
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
    validateMedicalStaffListVerified,
    validateDocumentsListQuery,
    validateObjectId,
    validateRejectionReason,
    validateSuspensionReason,
    validateAssignDuty,
    validateUnlockOtp,
    validateAdminOverrideStatus,
    validateAdminCreation,
    validateAdminRoleChange,
    validateRoleChangeOtp,
    validateAdminListQuery,
} = require('../middleware/admin.middleware');

const {
    validateDutyCreation,
    validateJobVacancyCreation,
    validatePagination,
    validateInterviewConfigUpdate
} = require('../middleware/validation.middleware');

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
router.get('/hospitals-list', requireCapability('hospital.view'), validateHospitalSimpleListQuery, adminController.getHospitalSimpleList);
router.get('/hospitals', requireCapability('hospital.view'), validateHospitalListQuery, adminController.listHospitals);
router.get('/hospitals/stats', requireCapability('hospital.view'), adminController.getHospitalStats);
router.get('/hospitals/:hospitalId', requireCapability('hospital.view'), validateObjectId('hospitalId'), adminController.getHospitalDetail);
router.patch('/hospitals/:hospitalId/verify', requireCapability('hospital.manage'), validateObjectId('hospitalId'), adminController.verifyHospital);
router.patch('/hospitals/:hospitalId/reject', requireCapability('hospital.manage'), validateObjectId('hospitalId'), validateRejectionReason, adminController.rejectHospital);
router.patch('/hospitals/:hospitalId/suspend', requireCapability('hospital.manage'), validateObjectId('hospitalId'), validateSuspensionReason, adminController.suspendHospital);
router.patch('/hospitals/:hospitalId/unsuspend', requireCapability('hospital.manage'), validateObjectId('hospitalId'), adminController.unsuspendHospital);

//dashboard api's
router.post('/create-duty', requireCapability('duty.manage'), validateDutyCreation, adminController.createDutyForHospital);
router.get('/dashboard-stats', requireCapability('dashboard.view'), adminController.getDashboardStats);
router.get('/staff-stats', requireCapability('dashboard.view'), adminController.getStaffStatistics);

//Job Vacancy Management endpoints (admin posts on behalf of a hospital)
router.post('/vacancy', requireCapability('vacancy.manage'), validateJobVacancyCreation, adminController.createVacancyForHospital);
router.get('/vacancies', requireCapability('vacancy.view'), validatePagination, adminController.listAllVacancies);

// Job application / interview oversight endpoints
router.get('/vacancy-applications', requireCapability('application.view'), validatePagination, adminController.listAllVacancyApplications);
router.get('/vacancy-applications/:applicationId', requireCapability('application.view'), validateObjectId('applicationId'), adminController.getVacancyApplicationDetail);
// No-show disputes are resolved via the ticket engine now —
// PATCH /api/admin/tickets/:id/decision + /approve — not this route.
router.get('/interview-config', requireCapability('interview.config.manage'), adminController.getInterviewConfig);
router.patch('/interview-config', requireCapability('interview.config.manage'), validateInterviewConfigUpdate, adminController.updateInterviewConfig);


//Medical Staff Management endpoints
router.get('/medical-staff/stats', requireCapability('staff.view'), adminController.getMedicalStaffStats);
router.get('/medical-staff/:staffId', requireCapability('staff.view'), validateObjectId('staffId'), adminController.getMedicalStaffDetail);
router.get('/medical-staff', requireCapability('staff.view'), validateMedicalStaffListQuery, adminController.getMedicalStaffList);
router.get('/medical-staff-list', requireCapability('staff.view'), validateMedicalStaffListVerified, adminController.getVerifiedMedicalStaffList);
router.patch('/medical-staff/:staffId/verify', requireCapability('staff.manage'), validateObjectId('staffId'), adminController.verifyMedicalStaff);
router.patch('/medical-staff/:staffId/reject', requireCapability('staff.manage'), validateObjectId('staffId'), validateRejectionReason, adminController.rejectMedicalStaff);
router.patch('/medical-staff/:staffId/suspend', requireCapability('staff.manage'), validateObjectId('staffId'), validateSuspensionReason, adminController.suspendMedicalStaff);
router.patch('/medical-staff/:staffId/unsuspend', requireCapability('staff.manage'), validateObjectId('staffId'), adminController.unsuspendMedicalStaff);

router.get('/nearby-staff', requireCapability('staff.view'), validateNearbyStaffQuery, adminController.getNearbyAvailableStaff);

router.get('/active-duties/export', requireCapability('duty.export'), adminController.exportActiveDuties);
router.get('/active-duties', requireCapability('duty.view'), validateActiveDutiesQuery, adminController.getActiveDuties);

router.get('/emergency-dashboard', requireCapability('duty.view'), adminController.getEmergencyDashboard);

router.get('/duty-route-map/:dutyId', requireCapability('duty.view'), validateDutyRouteMap, adminController.getDutyRouteMap);

// Overnight duties and duty history
router.get('/overnight-duties', requireCapability('duty.view'), validateOvernightDutiesQuery, adminController.getOvernightDuties);
router.get('/duty-history', requireCapability('duty.view'), validateDutyHistoryQuery, adminController.getDutyHistory);

//get profile of admin
router.get('/profile', adminController.getAdminProfile);
router.post('/flush-sessions', requireCapability('admin.sessions'), adminController.flushUserSessions);

// Document verification routes
router.get('/documents/stats', requireCapability('document.view'), adminController.getDocumentStats);
router.get('/documents', requireCapability('document.view'), validateDocumentsListQuery, adminController.getAllDocuments);
router.put('/documents/:documentId/verify', requireCapability('document.manage'), validateObjectId('documentId'), adminController.verifyDocument);
router.put('/documents/:documentId/reject', requireCapability('document.manage'), validateObjectId('documentId'), validateRejectionReason, adminController.rejectDocument);

router.post('/assign-duty', requireCapability('duty.manage'), validateAssignDuty, adminController.assignDutyToStaff);


// Duty Management endpoints for admin
router.patch(
    '/duties/:id/unlock-otp',
    requireCapability('duty.manage'),
    validateObjectId('id'),
    validateUnlockOtp,
    adminController.unlockDutyOtp
);

router.patch(
    '/duties/:id/admin-override',
    requireCapability('duty.manage'),
    validateObjectId('id'),
    validateAdminOverrideStatus,
    adminController.adminOverrideDutyStatus
);


// Admin Management endpoints (super_admin only, except listing/detail which operations_manager can also view)
router.post('/create-admin', requireCapability('admin.manage'), validateAdminCreation, adminManagementController.createAdmin);
router.get('/admin-list', requireCapability('admin.view'), validateAdminListQuery, adminManagementController.listAdmins);
router.get('/admin-detail/:adminId', requireCapability('admin.view'), validateObjectId('adminId'), adminManagementController.getAdminDetail);
router.patch('/update-admin-role/:adminId', requireCapability('admin.manage'), otpRateLimit, validateObjectId('adminId'), validateAdminRoleChange, adminManagementController.initiateRoleChange);
router.post('/update-admin-role/verify-otp', requireCapability('admin.manage'), otpRateLimit, validateRoleChangeOtp, adminManagementController.verifyRoleChangeOtp);
router.post('/update-admin-role/resend-otp', requireCapability('admin.manage'), otpRateLimit, adminManagementController.resendRoleChangeOtp);
router.delete('/deactivate-admin/:adminId', requireCapability('admin.manage'), validateObjectId('adminId'), adminManagementController.deactivateAdmin);
router.patch('/activate-admin/:adminId', requireCapability('admin.manage'), validateObjectId('adminId'), adminManagementController.activateAdmin);


module.exports = router;
