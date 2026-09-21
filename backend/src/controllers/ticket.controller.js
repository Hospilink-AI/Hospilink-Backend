const ticketService = require('../services/ticket.service');
const ticketChatService = require('../services/ticketChat.service');
const { asyncHandler } = require('../middleware/error.middleware');

// POST /api/tickets — IN_APP_FORM path (chatbot path lands in a later phase)
exports.createTicket = asyncHandler(async (req, res) => {
    const ticket = await ticketService.createTicket(req.user, req.validatedBody);
    res.status(201).json({ success: true, ticket, message: 'Ticket submitted' });
});

// GET /api/tickets/mine
exports.listMine = asyncHandler(async (req, res) => {
    const { status, category, page = 1, limit = 10 } = req.query;
    const result = await ticketService.listMine(
        req.user.id, { status, category }, { page: parseInt(page), limit: parseInt(limit) }
    );
    res.status(200).json({
        success: true,
        count: result.tickets.length,
        data: result.tickets,
        pagination: result.pagination
    });
});

// GET /api/tickets/:id — shared by raiser, respondent and admin
exports.getById = asyncHandler(async (req, res) => {
    const ticket = await ticketService.getById(req.params.id, req.user);
    res.status(200).json({ success: true, ticket });
});

// PATCH /api/tickets/:id/withdraw — raiser-only
exports.withdraw = asyncHandler(async (req, res) => {
    const ticket = await ticketService.withdraw(req.params.id, req.user, req.validatedBody.reason);
    res.status(200).json({ success: true, ticket, message: 'Ticket withdrawn' });
});

// GET /api/tickets/against-me — claims raised against the caller
exports.listAgainstMe = asyncHandler(async (req, res) => {
    const { status, category, page = 1, limit = 10 } = req.query;
    const result = await ticketService.listAgainstMe(
        req.user, { status, category }, { page: parseInt(page), limit: parseInt(limit) }
    );
    res.status(200).json({
        success: true,
        count: result.tickets.length,
        data: result.tickets,
        pagination: result.pagination
    });
});

// POST /api/tickets/:id/respond — respondent-only
exports.respond = asyncHandler(async (req, res) => {
    const ticket = await ticketService.respond(req.params.id, req.user, req.validatedBody);
    res.status(200).json({ success: true, ticket, message: 'Response submitted' });
});

// POST /api/tickets/:id/appeal — either party to a decided ticket
exports.appeal = asyncHandler(async (req, res) => {
    const appealTicket = await ticketService.appeal(req.params.id, req.user, req.validatedBody);
    res.status(201).json({ success: true, ticket: appealTicket, message: 'Appeal submitted' });
});

// POST /api/tickets/:id/evidence — raiser, respondent, or admin
exports.addEvidence = asyncHandler(async (req, res) => {
    const ticket = await ticketService.addEvidence(req.params.id, req.user, req.files || []);
    res.status(200).json({ success: true, ticket, message: 'Evidence added' });
});

// POST /api/tickets/:id/chat — raiser or respondent's own thread with the admin
exports.sendChatMessage = asyncHandler(async (req, res) => {
    const thread = await ticketChatService.sendMessage(req.params.id, req.user, { ...req.validatedBody, files: req.files || [] });
    res.status(201).json({ success: true, thread, message: 'Message sent' });
});

// GET /api/tickets/:id/chat — raiser or respondent's own thread
exports.getChatThread = asyncHandler(async (req, res) => {
    const thread = await ticketChatService.getThread(req.params.id, req.user);
    res.status(200).json({ success: true, thread });
});
