const express = require('express');
const router = express.Router();
const feedbackController = require('../controllers/feedback.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { validateFeedbackSubmission } = require('../middleware/validation.middleware');

router.use(protect);
router.use(checkSuspension);
router.use(authorize('staff', 'hospital'));

router.post('/', validateFeedbackSubmission, feedbackController.submit);

router.get('/mine', feedbackController.listMine);

module.exports = router;
