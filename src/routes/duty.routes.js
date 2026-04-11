const express = require('express');
const router = express.Router();
const dutyController = require('../controllers/duty.controller');
const { protect, authorize } = require('../middleware/auth.middleware');
const { 
    validateDutyStatusHistory, 
    validateLocationPermission, 
    validateDutyCreation,
    validateDutyAcceptance,
    validateDutyStatusChange,
    validateDutyCancellation,
    validateDutyEdit,
    validatePagination,
    validateObjectId,
    validateStatementQuery
} = require('../middleware/validation.middleware');

// Apply protection to all duty routes
router.use(protect);

router.post(
    '/hospitals/:hospitalId/duties',
    authorize('hospital'),
    validateDutyCreation,
    dutyController.createDuty
);

router.get('/duties-published', authorize('hospital'), validatePagination, dutyController.getDuties);

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

router.get('/duties/:id', validateObjectId('id'), dutyController.getDutyDetail);

router.post('/duties/:id/route', authorize('staff'), dutyController.getDutyRoute);

router.patch('/duties/:id/cancel', authorize('hospital'), validateDutyCancellation, dutyController.cancelDuty);

module.exports = router;