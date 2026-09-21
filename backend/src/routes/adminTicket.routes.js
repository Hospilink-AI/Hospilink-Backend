const express = require('express');
const router = express.Router();
const adminTicketController = require('../controllers/adminTicket.controller');
const { protect, authorize, requireCapability } = require('../middleware/auth.middleware');
const { ticketEvidenceUpload, validateMagicBytes } = require('../middleware/upload.middleware');
const {
    validatePagination, validateObjectId, validateTicketReassign,
    validateTicketRecategorize, validateTicketPriorityOverride,
    validateTicketRequestInfo, validateAdminTicketChatMessage,
    validateTicketDecision, validateTicketReturnForReview
} = require('../middleware/validation.middleware');

// Kept separate from admin.routes.js (already large), same convention as
// activityLog.routes.js being mounted on its own rather than folded in.
router.use(protect);
router.use(authorize('admin'));

router.get('/', requireCapability('ticket.view'), validatePagination, adminTicketController.listQueue);

router.get('/triage', requireCapability('ticket.view'), validatePagination, adminTicketController.listTriage);

// Declared before '/:id/...' patches purely as a defensive convention —
// '/approval-queue' doesn't actually collide with a 2-segment '/:id/...'
// path, but literal routes before param routes is the habit this codebase
// already keeps elsewhere (e.g. jobApplication.routes.js).
router.get('/approval-queue', requireCapability('ticket.approve'), validatePagination, adminTicketController.listApprovalQueue);

router.patch('/:id/claim', requireCapability('ticket.claim'), validateObjectId('id'), adminTicketController.claim);

router.patch(
    '/:id/reassign',
    requireCapability('ticket.claim'),
    validateObjectId('id'),
    validateTicketReassign,
    adminTicketController.reassign
);

router.patch(
    '/:id/recategorize',
    requireCapability('ticket.claim'),
    validateObjectId('id'),
    validateTicketRecategorize,
    adminTicketController.recategorize
);

router.patch(
    '/:id/priority-override',
    requireCapability('ticket.claim'),
    validateObjectId('id'),
    validateTicketPriorityOverride,
    adminTicketController.priorityOverride
);

router.patch(
    '/:id/request-info',
    requireCapability('ticket.claim'),
    validateObjectId('id'),
    validateTicketRequestInfo,
    adminTicketController.requestInfo
);

// Day 3 — admin sends/reads a message on a specific party's thread. Same
// 'ticket.claim' floor as reassign/recategorize/priority-override/request-info.
router.post(
    '/:id/chat',
    requireCapability('ticket.claim'),
    validateObjectId('id'),
    ticketEvidenceUpload.array('files', 5),
    validateMagicBytes,
    validateAdminTicketChatMessage,
    adminTicketController.sendChatMessage
);

router.get(
    '/:id/chat',
    requireCapability('ticket.claim'),
    validateObjectId('id'),
    adminTicketController.getChatThread
);

router.post(
    '/:id/decision',
    requireCapability('ticket.decide'),
    validateObjectId('id'),
    validateTicketDecision,
    adminTicketController.decide
);

router.patch('/:id/approve', requireCapability('ticket.approve'), validateObjectId('id'), adminTicketController.approve);

router.patch(
    '/:id/return-for-review',
    requireCapability('ticket.approve'),
    validateObjectId('id'),
    validateTicketReturnForReview,
    adminTicketController.returnForReview
);

module.exports = router;
