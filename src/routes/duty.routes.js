const express = require('express');
const router = express.Router();
const dutyController = require('../controllers/duty.controller');
const { protect, authorize } = require('../middleware/auth.middleware');
const { validateDutyStatusHistory, validateLocationPermission, validateDutyCreation } = require('../middleware/validation.middleware');

// Apply protection to all duty routes
router.use(protect);

router.post(
    '/hospitals/:hospitalId/duties',
    authorize('hospital'),
    validateDutyCreation,
    dutyController.createDuty
);

router.get('/duties-published', authorize('hospital'), dutyController.getDuties);


router.get('/duties/available', authorize('staff'), validateLocationPermission, dutyController.getAvailableJobsWithDistance);

router.get('/duties/my-upcoming', authorize('staff'), validateLocationPermission, dutyController.getMyUpcomingDuties);

router.get('/duties/ongoing', authorize('staff'), dutyController.getOngoingDuties);

router.post(
    '/staff/accept-duty',
    authorize('staff'),
    dutyController.acceptDuty
);

router.patch(
    '/duties/status',
    authorize('staff'),
    dutyController.changeDutyStatus
);

router.post(
    '/duty/status-history',
    validateDutyStatusHistory,
    dutyController.getDutyStatusHistory
);


router.get('/completed-duties', authorize('staff'), dutyController.getCompletedDuties);


router.patch(
    '/duties/:id',
    authorize('hospital'),
    dutyController.editDuty
);

//get statement and receipt pdf
router.get(
    '/duties/statement',
    authorize('staff'),
    dutyController.getStatement
);

router.get('/duties/:id', dutyController.getDutyDetail);


router.post('/duties/:id/route', authorize('staff'), validateLocationPermission, dutyController.getDutyRoute);


router.patch('/duties/:id/cancel', authorize('hospital'), dutyController.cancelDuty);

module.exports = router;