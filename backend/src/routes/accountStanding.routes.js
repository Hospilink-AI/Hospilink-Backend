const express = require('express');
const router = express.Router();
const accountStandingController = require('../controllers/accountStanding.controller');
const { protect, authorize } = require('../middleware/auth.middleware');
const { validateObjectId, validateSuspensionResponse } = require('../middleware/validation.middleware');

// Deliberately no checkSuspension here, unlike every other user-facing
// route group. A party who's already suspended must still be able to see
// exactly why (spec §10.04: "a flag nobody can see is a shadow record") —
// gating this behind checkSuspension would lock someone out of the one
// screen that explains their own suspension. The PATCH respond endpoint
// doesn't need the guard either: responding to an already-decided
// proposal is already rejected by patternEngine.service.js's own status
// check, regardless of whether checkSuspension would also have blocked it.
router.use(protect);
router.use(authorize('staff', 'hospital'));

// Declared before the wildcard-bearing PATCH route below, same defensive
// convention used throughout — not strictly required here since there's no
// literal/param collision, but kept consistent.
router.get('/pattern-flags', accountStandingController.listMyFlags);

router.get('/suspension-proposals', accountStandingController.listMySuspensionProposals);

router.patch(
    '/suspension-proposals/:id/respond',
    validateObjectId('id'),
    validateSuspensionResponse,
    accountStandingController.respondToSuspensionProposal
);

module.exports = router;
