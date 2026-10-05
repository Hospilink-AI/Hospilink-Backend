const express = require('express');
const router = express.Router();
const blockController = require('../controllers/block.controller');
const { protect, authorize } = require('../middleware/auth.middleware');
const { validateObjectId } = require('../middleware/validation.middleware');

// Blocking works while suspended too, so no checkSuspension
router.use(protect);

router.get('/', authorize('staff', 'hospital'), blockController.listBlocked);

router.post('/hospitals/:hospitalId', authorize('staff'), validateObjectId('hospitalId'), blockController.blockHospital);
router.delete('/hospitals/:hospitalId', authorize('staff'), validateObjectId('hospitalId'), blockController.unblockHospital);

router.post('/staff/:staffId', authorize('hospital'), validateObjectId('staffId'), blockController.blockStaff);
router.delete('/staff/:staffId', authorize('hospital'), validateObjectId('staffId'), blockController.unblockStaff);

module.exports = router;
