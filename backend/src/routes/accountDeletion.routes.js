const express = require('express');
const router = express.Router();
const accountDeletionController = require('../controllers/accountDeletion.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// No checkSuspension: a suspended doctor or hospital can still delete their account
router.use(protect);
router.use(authorize('staff', 'hospital'));

router.get('/', accountDeletionController.getStatus);
router.get('/preview', accountDeletionController.getPreview);
router.post('/', accountDeletionController.requestDeletion);

module.exports = router;
