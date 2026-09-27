const knowledgeBaseService = require('../services/knowledgeBase.service');
const { asyncHandler } = require('../middleware/error.middleware');

// GET /api/admin/knowledge-base
exports.list = asyncHandler(async (req, res) => {
    const { category, isActive, page = 1, limit = 10 } = req.query;
    const filters = { category };
    if (isActive !== undefined) filters.isActive = isActive === 'true';
    const result = await knowledgeBaseService.list(filters, { page: parseInt(page), limit: parseInt(limit) });
    res.status(200).json({
        success: true,
        count: result.articles.length,
        data: result.articles,
        pagination: result.pagination
    });
});

// GET /api/admin/knowledge-base/:id
exports.getById = asyncHandler(async (req, res) => {
    const article = await knowledgeBaseService.getById(req.params.id);
    res.status(200).json({ success: true, article });
});

// POST /api/admin/knowledge-base
exports.create = asyncHandler(async (req, res) => {
    const article = await knowledgeBaseService.create(req.user, req.validatedBody);
    res.status(201).json({ success: true, article, message: 'Article created' });
});

// PATCH /api/admin/knowledge-base/:id
exports.update = asyncHandler(async (req, res) => {
    const article = await knowledgeBaseService.update(req.params.id, req.user, req.validatedBody);
    res.status(200).json({ success: true, article, message: 'Article updated' });
});

// PATCH /api/admin/knowledge-base/:id/deactivate
exports.deactivate = asyncHandler(async (req, res) => {
    const article = await knowledgeBaseService.setActive(req.params.id, req.user, false);
    res.status(200).json({ success: true, article, message: 'Article deactivated' });
});

// PATCH /api/admin/knowledge-base/:id/reactivate
exports.reactivate = asyncHandler(async (req, res) => {
    const article = await knowledgeBaseService.setActive(req.params.id, req.user, true);
    res.status(200).json({ success: true, article, message: 'Article reactivated' });
});
