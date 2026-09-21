const express = require('express');
const router = express.Router();
const ticketController = require('../controllers/ticket.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { ticketEvidenceUpload, validateMagicBytes } = require('../middleware/upload.middleware');
const {
    validateTicketCreation, validatePagination, validateObjectId, validateTicketWithdraw,
    validateTicketRespond, validateTicketAppeal, validateTicketChatMessage
} = require('../middleware/validation.middleware');

router.use(protect);
router.use(checkSuspension);

// Raising and viewing tickets — staff and hospital only this phase. Admin
// read access to GET /:id is handled inside ticketService.getById (the
// route serves both a raiser/respondent's own ticket and an admin's case
// file, so the capability check can't live on the route alone) — 'admin' is
// included in authorize() here so a valid admin token isn't rejected before
// that check ever runs.
router.post('/', authorize('staff', 'hospital'), validateTicketCreation, ticketController.createTicket);

router.get('/mine', authorize('staff', 'hospital'), validatePagination, ticketController.listMine);

// Declared before '/:id' so it isn't swallowed by the wildcard param —
// same defensive-ordering convention jobApplication.routes.js uses for
// '/applications/mine'.
router.get('/against-me', authorize('staff', 'hospital'), validatePagination, ticketController.listAgainstMe);

router.get('/:id', authorize('staff', 'hospital', 'admin'), validateObjectId('id'), ticketController.getById);

router.patch(
    '/:id/withdraw',
    authorize('staff', 'hospital'),
    validateObjectId('id'),
    validateTicketWithdraw,
    ticketController.withdraw
);

router.post(
    '/:id/respond',
    authorize('staff', 'hospital'),
    validateObjectId('id'),
    validateTicketRespond,
    ticketController.respond
);

router.post(
    '/:id/appeal',
    authorize('staff', 'hospital'),
    validateObjectId('id'),
    validateTicketAppeal,
    ticketController.appeal
);

router.post(
    '/:id/evidence',
    authorize('staff', 'hospital', 'admin'),
    validateObjectId('id'),
    ticketEvidenceUpload.array('files', 5),
    validateMagicBytes,
    ticketController.addEvidence
);

// Day 3 — raiser/respondent's own thread with the admin. Party is implicit
// (derived from the caller's relation to the ticket), unlike the admin-side
// route which must say which party's thread it means.
router.post(
    '/:id/chat',
    authorize('staff', 'hospital'),
    validateObjectId('id'),
    ticketEvidenceUpload.array('files', 5),
    validateMagicBytes,
    validateTicketChatMessage,
    ticketController.sendChatMessage
);

router.get(
    '/:id/chat',
    authorize('staff', 'hospital'),
    validateObjectId('id'),
    ticketController.getChatThread
);

module.exports = router;
