const express = require('express');
const router = express.Router();
const staffAvailabilityController = require('../controllers/staffAvailability.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { requireVerifiedStaffOnly } = require('../middleware/accountsVerification.middleware');
const {
    validateCalendarCountsQuery,
    validateAvailabilityWeekly,
    validateAvailabilityDates
} = require('../middleware/validation.middleware');

// A doctor's own availability calendar. Verified staff only; it works with
// the availability switch off, since it is about future days.
router.use(protect);
router.use(checkSuspension);
router.use(authorize('staff'));
router.use(requireVerifiedStaffOnly);

router.get('/', validateCalendarCountsQuery, staffAvailabilityController.getAvailability);
router.put('/weekly', validateAvailabilityWeekly, staffAvailabilityController.setWeekly);
router.put('/dates', validateAvailabilityDates, staffAvailabilityController.setDates);

module.exports = router;
