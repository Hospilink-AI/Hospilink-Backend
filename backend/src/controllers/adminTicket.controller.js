const ticketService = require('../services/ticket.service');
const ticketChatService = require('../services/ticketChat.service');
const { asyncHandler } = require('../middleware/error.middleware');

// GET /api/admin/tickets — the main work queue
exports.listQueue = asyncHandler(async (req, res) => {
    const { domain, category, priority, queue, status, page = 1, limit = 10 } = req.query;
    const result = await ticketService.listQueue(
        req.user, { domain, category, priority, queue, status }, { page: parseInt(page), limit: parseInt(limit) }
    );
    res.status(200).json({
        success: true,
        count: result.tickets.length,
        data: result.tickets,
        pagination: result.pagination
    });
});

// GET /api/admin/tickets/triage
exports.listTriage = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10 } = req.query;
    const result = await ticketService.listTriage(req.user, { page: parseInt(page), limit: parseInt(limit) });
    res.status(200).json({
        success: true,
        count: result.tickets.length,
        data: result.tickets,
        pagination: result.pagination
    });
});

// PATCH /api/admin/tickets/:id/claim
exports.claim = asyncHandler(async (req, res) => {
    const ticket = await ticketService.claim(req.params.id, req.user);
    res.status(200).json({ success: true, ticket, message: 'Ticket claimed' });
});

// PATCH /api/admin/tickets/:id/reassign
exports.reassign = asyncHandler(async (req, res) => {
    const ticket = await ticketService.reassign(req.params.id, req.user, req.validatedBody);
    res.status(200).json({ success: true, ticket, message: 'Ticket reassigned' });
});

// PATCH /api/admin/tickets/:id/recategorize
exports.recategorize = asyncHandler(async (req, res) => {
    const ticket = await ticketService.recategorize(req.params.id, req.user, req.validatedBody);
    res.status(200).json({ success: true, ticket, message: 'Ticket recategorized' });
});

// PATCH /api/admin/tickets/:id/priority-override
exports.priorityOverride = asyncHandler(async (req, res) => {
    const ticket = await ticketService.priorityOverride(req.params.id, req.user, req.validatedBody);
    res.status(200).json({ success: true, ticket, message: 'Priority overridden' });
});

// PATCH /api/admin/tickets/:id/request-info
exports.requestInfo = asyncHandler(async (req, res) => {
    const ticket = await ticketService.requestInfo(req.params.id, req.user, req.validatedBody);
    res.status(200).json({ success: true, ticket, message: 'Information requested from raiser' });
});

// POST /api/admin/tickets/:id/chat — admin sends a message on the raiser's
// or respondent's thread (req.validatedBody.party says which)
exports.sendChatMessage = asyncHandler(async (req, res) => {
    const thread = await ticketChatService.sendMessage(req.params.id, req.user, { ...req.validatedBody, files: req.files || [] });
    res.status(201).json({ success: true, thread, message: 'Message sent' });
});

// GET /api/admin/tickets/:id/chat?party=raiser|respondent
exports.getChatThread = asyncHandler(async (req, res) => {
    const thread = await ticketChatService.getThread(req.params.id, req.user, req.query.party);
    res.status(200).json({ success: true, thread });
});

// POST /api/admin/tickets/:id/decision
exports.decide = asyncHandler(async (req, res) => {
    const ticket = await ticketService.decide(req.params.id, req.user, req.validatedBody);
    const message = ticket.status === 'PENDING_APPROVAL' ? 'Decision proposed, awaiting approval' : 'Ticket decided';
    res.status(200).json({ success: true, ticket, message });
});

// GET /api/admin/tickets/approval-queue
exports.listApprovalQueue = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10 } = req.query;
    const result = await ticketService.listApprovalQueue(req.user, { page: parseInt(page), limit: parseInt(limit) });
    res.status(200).json({
        success: true,
        count: result.tickets.length,
        data: result.tickets,
        pagination: result.pagination
    });
});

// PATCH /api/admin/tickets/:id/approve
exports.approve = asyncHandler(async (req, res) => {
    const ticket = await ticketService.approveDecision(req.params.id, req.user);
    res.status(200).json({ success: true, ticket, message: 'Decision approved and executed' });
});

// PATCH /api/admin/tickets/:id/return-for-review
exports.returnForReview = asyncHandler(async (req, res) => {
    const ticket = await ticketService.returnForReview(req.params.id, req.user, req.validatedBody.reason);
    res.status(200).json({ success: true, ticket, message: 'Returned for review' });
});
