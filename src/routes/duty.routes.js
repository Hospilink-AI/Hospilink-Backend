const express = require('express');
const router = express.Router();
const dutyController = require('../controllers/duty.controller');
const { protect, authorize } = require('../middleware/auth.middleware');
const { requireHospitalVerification } = require('../middleware/accountsVerification.middleware');
const { 
    validateDutyStatusHistory, 
    validateDutyCreation,
    validateDutyAcceptance,
    validateDutyStatusChange,
    validateDutyCancellation,
    validateDutyEdit,
    validatePagination,
    validateObjectId,
    validateStatementQuery,
    validateHospitalActiveDutiesQuery,
    validateHospitalDutyRouteMap
} = require('../middleware/validation.middleware');

// Apply protection to all duty routes
router.use(protect);

router.post(
    '/hospitals/:hospitalId/duties',
    authorize('hospital'),
    requireHospitalVerification, 
    validateDutyCreation,
    dutyController.createDuty
);

router.get('/duties-published', authorize('hospital'), requireHospitalVerification, validatePagination, dutyController.getDuties);

router.get('/duties/available', authorize('staff'), dutyController.getAvailableJobsWithDistance);

router.get('/duties/my-upcoming', authorize('staff'), dutyController.getMyUpcomingDuties);

router.get('/duties/ongoing', authorize('staff'), validatePagination, dutyController.getOngoingDuties);

router.post(
    '/staff/accept-duty',
    authorize('staff'),
    validateDutyAcceptance,
    dutyController.acceptDuty
);

router.patch(
    '/duties/status',
    authorize('staff'),
    validateDutyStatusChange,
    dutyController.changeDutyStatus
);

router.post(
    '/duty/status-history',
    validateDutyStatusHistory,
    dutyController.getDutyStatusHistory
);

router.get('/completed-duties', authorize('staff'), validatePagination, dutyController.getCompletedDuties);

router.patch(
    '/duties/:id',
    authorize('hospital'),
    requireHospitalVerification,
    validateDutyEdit,
    dutyController.editDuty
);

//get statement and receipt pdf
router.get(
    '/duties/statement',
    authorize('staff'),
    validateStatementQuery,
    dutyController.getStatement
);


// Hospital active duties and route map endpoints
router.get('/duties/active-duties', authorize('hospital'), requireHospitalVerification, validateHospitalActiveDutiesQuery, dutyController.getHospitalActiveDuties);
 
router.get('/duties/duty-route-map/:dutyId', authorize('hospital'), requireHospitalVerification, validateHospitalDutyRouteMap, dutyController.getHospitalDutyRouteMap);

router.get('/duties/:id', validateObjectId('id'), dutyController.getDutyDetail);

router.post('/duties/:id/route', authorize('staff'), dutyController.getDutyRoute);

router.patch('/duties/:id/cancel', authorize('hospital'), requireHospitalVerification, validateDutyCancellation, dutyController.cancelDuty);


module.exports = router;