const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { requireHospitalVerification } = require('../middleware/accountsVerification.middleware');

// Apply protection to all hospital dashboard routes
router.use(protect);
router.use(checkSuspension);
router.use(authorize('hospital'));
router.use(requireHospitalVerification); 

// Hospital Dashboard endpoints
router.get('/staff-stats', adminController.getStaffStatistics);

module.exports = router;