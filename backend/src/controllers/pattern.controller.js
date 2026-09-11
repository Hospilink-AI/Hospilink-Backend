const patternEngineService = require('../services/patternEngine.service');
const { asyncHandler } = require('../middleware/error.middleware');

// GET /api/admin/patterns
exports.listPatterns = asyncHandler(async (req, res) => {
    const { status, raises, page = 1, limit = 10 } = req.query;
    const result = await patternEngineService.listForAdmin(
        req.user, { status, raises }, { page: parseInt(page), limit: parseInt(limit) }
    );
    res.status(200).json({
        success: true,
        count: result.flags.length,
        data: result.flags,
        pagination: result.pagination
    });
});

// GET /api/admin/patterns/:id
exports.getPattern = asyncHandler(async (req, res) => {
    const flag = await patternEngineService.getById(req.params.id, req.user);
    res.status(200).json({ success: true, flag });
});

// GET /api/admin/suspension-proposals
exports.listSuspensionProposals = asyncHandler(async (req, res) => {
    const { page = 1, limit = 10 } = req.query;
    const result = await patternEngineService.listSuspensionProposals(req.user, { page: parseInt(page), limit: parseInt(limit) });
    res.status(200).json({
        success: true,
        count: result.flags.length,
        data: result.flags,
        pagination: result.pagination
    });
});

// PATCH /api/admin/suspension-proposals/:id/decide
exports.decideSuspensionProposal = asyncHandler(async (req, res) => {
    const flag = await patternEngineService.decideProposal(req.params.id, req.user, req.validatedBody);
    res.status(200).json({ success: true, flag, message: `Proposal decided: ${req.validatedBody.decision}` });
});
