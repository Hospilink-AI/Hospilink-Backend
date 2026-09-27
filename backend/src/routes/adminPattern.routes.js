const express = require('express');
const router = express.Router();
const patternController = require('../controllers/pattern.controller');
const { protect, authorize, requireCapability } = require('../middleware/auth.middleware');
const { validatePagination, validateObjectId, validateSuspensionDecision } = require('../middleware/validation.middleware');

router.use(protect);
router.use(authorize('admin'));

// Declared before '/:id' so it isn't swallowed by the wildcard param.
router.get('/suspension-proposals', requireCapability('pattern.view'), validatePagination, patternController.listSuspensionProposals);

router.patch(
    '/suspension-proposals/:id/decide',
    requireCapability('suspension.decide'),
    validateObjectId('id'),
    validateSuspensionDecision,
    patternController.decideSuspensionProposal
);

router.get('/patterns', requireCapability('pattern.view'), validatePagination, patternController.listPatterns);

router.get('/patterns/:id', requireCapability('pattern.view'), validateObjectId('id'), patternController.getPattern);

module.exports = router;
