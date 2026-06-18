const express = require('express');
const router = express.Router();
const dutyController = require('../controllers/duty.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { requireHospitalVerification, requireStaffVerificationandisAvailable} = require('../middleware/accountsVerification.middleware');
const {
    validateDutyStatusHistory,
    validateDutyCreation,
    validateDutyAcceptance,
    validateDutyStatusChange,
    validateRequestStartOtp,
    validateVerifyStartOtp,
    validateVerifyEndOtp,
    validateRaiseDispute,
    validateDutyCancellation,
    validateDutyEdit,
    validatePagination,
    validateObjectId,
    validateStatementQuery,
    validateHospitalDutyRouteMap,
    validateHospitalActiveDutiesQuery
} = require('../middleware/validation.middleware');

// Apply protection to all duty routes
router.use(protect);
router.use(checkSuspension);

router.post(
    '/hospitals/:hospitalId/duties',
    authorize('hospital'),
    requireHospitalVerification, 
    validateDutyCreation,
    dutyController.createDuty
);

router.get('/duties-published', authorize('hospital'), requireHospitalVerification, validatePagination, dutyController.getActiveDuties);

router.get('/duties/history', authorize('hospital'), requireHospitalVerification, validatePagination, dutyController.getDutyHistory);

router.get('/duties/available', authorize('staff'), requireStaffVerificationandisAvailable, dutyController.getAvailableJobsWithDistance);

router.get('/duties/my-upcoming', authorize('staff'), requireStaffVerificationandisAvailable, dutyController.getMyUpcomingDuties);

router.get('/duties/ongoing', authorize('staff'), requireStaffVerificationandisAvailable, validatePagination, dutyController.getOngoingDuties);

router.post(
    '/staff/accept-duty',
    authorize('staff'),
    requireStaffVerificationandisAvailable, 
    validateDutyAcceptance,
    dutyController.acceptDuty
);

router.patch(
    '/duties/status',
    authorize('staff'),
    requireStaffVerificationandisAvailable,
    validateDutyStatusChange,
    dutyController.changeDutyStatus
);

router.post(
    '/duties/:id/request-start-otp',
    authorize('staff'),
    requireStaffVerificationandisAvailable,
    validateObjectId('id'),
    validateRequestStartOtp,
    dutyController.requestStartOtp
);

router.post(
    '/duties/:id/verify-start-otp',
    authorize('staff'),
    requireStaffVerificationandisAvailable,
    validateObjectId('id'),
    validateVerifyStartOtp,
    dutyController.verifyStartOtp
);

router.post(
    '/duties/:id/request-end-otp',
    authorize('staff'),
    requireStaffVerificationandisAvailable,
    validateObjectId('id'),
    dutyController.requestEndOtp
);

router.post(
    '/duties/:id/verify-end-otp',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('id'),
    validateVerifyEndOtp,
    dutyController.verifyEndOtp
);

router.post(
    '/duties/:id/regenerate-end-otp',
    authorize('staff', 'hospital'),
    validateObjectId('id'),
    dutyController.regenerateEndOtp
);

router.post(
    '/duties/:id/dispute',
    authorize('staff', 'hospital'),
    validateObjectId('id'),
    validateRaiseDispute,
    dutyController.raiseDispute
);


router.post(
    '/duty/status-history',
    authorize('staff', 'hospital', 'admin'),
    validateDutyStatusHistory,
    dutyController.getDutyStatusHistory
);

router.get('/completed-duties', authorize('staff'), requireStaffVerificationandisAvailable, validatePagination, dutyController.getCompletedDuties);

router.patch(
    '/duties/:id',
    authorize('hospital'),
    requireHospitalVerification,
    validateDutyEdit,
    dutyController.editDuty
);

router.get(
    '/duties/statement',
    authorize('staff'),
    requireStaffVerificationandisAvailable, 
    validateStatementQuery,
    dutyController.getStatement
);


// Hospital active duties and route map endpoints
router.get('/duties/active-duties', authorize('hospital'), requireHospitalVerification, validateHospitalActiveDutiesQuery, dutyController.getHospitalActiveDuties);
 
router.get('/duties/duty-route-map/:dutyId', authorize('hospital'), requireHospitalVerification, validateHospitalDutyRouteMap, dutyController.getHospitalDutyRouteMap);

router.get('/duties/:id', validateObjectId('id'), authorize('staff', 'hospital', 'admin'), dutyController.getDutyDetail);

router.post('/duties/:id/route', authorize('staff'), requireStaffVerificationandisAvailable, dutyController.getDutyRoute);

router.patch('/duties/:id/cancel', authorize('hospital'), requireHospitalVerification, validateDutyCancellation, dutyController.cancelDuty);


module.exports = router;