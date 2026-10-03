const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analytics.controller');
const analyticsService = require('../services/analytics');
const { protect, authorize, requireCapability } = require('../middleware/auth.middleware');
const { validateAnalyticsQuery } = require('../middleware/validation.middleware');

// Super Admin only: 'analytics.view' is granted to no other sub-role
router.use(protect);
router.use(authorize('admin'));
router.use(requireCapability('analytics.view'));

router.get('/catalogue', analyticsController.getCatalogue);

router.get(
    `/:section(${analyticsService.sections.join('|')})`,
    validateAnalyticsQuery,
    analyticsController.getSection
);

module.exports = router;
