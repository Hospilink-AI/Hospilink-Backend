const patternEngineService = require('../services/patternEngine.service');
const { asyncHandler } = require('../middleware/error.middleware');

// GET /api/account/pattern-flags — spec §10.04: never a shadow record.
exports.listMyFlags = asyncHandler(async (req, res) => {
    const flags = await patternEngineService.listForParty(req.user);
    res.status(200).json({ success: true, count: flags.length, data: flags });
});

// GET /api/account/suspension-proposals
exports.listMySuspensionProposals = asyncHandler(async (req, res) => {
    const flags = await patternEngineService.listForParty(req.user);
    const proposals = flags.filter(f => f.raises === 'suspension_proposal');
    res.status(200).json({ success: true, count: proposals.length, data: proposals });
});

// PATCH /api/account/suspension-proposals/:id/respond
exports.respondToSuspensionProposal = asyncHandler(async (req, res) => {
    const flag = await patternEngineService.respondToProposal(req.params.id, req.user, req.validatedBody);
    res.status(200).json({ success: true, flag, message: 'Response submitted' });
});
