const express = require('express');
const router = express.Router();
const adminFeedbackController = require('../controllers/adminFeedback.controller');
const { protect, authorize, requireCapability } = require('../middleware/auth.middleware');
const { validatePagination, validateObjectId, validateSentimentOverride } = require('../middleware/validation.middleware');

router.use(protect);
router.use(authorize('admin'));

router.get('/', requireCapability('feedback.view'), validatePagination, adminFeedbackController.list);

router.patch(
    '/:id/override-sentiment',
    requireCapability('feedback.view'),
    validateObjectId('id'),
    validateSentimentOverride,
    adminFeedbackController.overrideSentiment
);

module.exports = router;
