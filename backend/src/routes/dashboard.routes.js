const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboard.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// Apply protection to all dashboard routes
router.use(protect);
router.use(authorize('staff'));

// Dashboard endpoints
router.get('/overview', dashboardController.getStaffOverview);
router.get('/stats', dashboardController.getStaffStats);
router.get('/upcoming-duties', dashboardController.getUpcomingDuties);
router.get('/earnings', dashboardController.getEarnings);
router.get('/availability', dashboardController.getAvailabilityStatus);

module.exports = router;