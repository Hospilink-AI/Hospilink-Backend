const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// Apply protection to all hospital dashboard routes
router.use(protect);
router.use(authorize('hospital'));

// Hospital Dashboard endpoints
router.get('/staff-stats', adminController.getStaffStatistics);

module.exports = router;