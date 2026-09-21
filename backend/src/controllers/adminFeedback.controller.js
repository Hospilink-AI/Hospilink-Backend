const feedbackService = require('../services/feedback.service');
const { asyncHandler } = require('../middleware/error.middleware');

// GET /api/admin/feedback
exports.list = asyncHandler(async (req, res) => {
    const { area, sentiment, page = 1, limit = 10 } = req.query;
    const result = await feedbackService.listForAdmin(req.user, { area, sentiment }, { page: parseInt(page), limit: parseInt(limit) });
    res.status(200).json({
        success: true,
        count: result.feedback.length,
        data: result.feedback,
        pagination: result.pagination
    });
});

// PATCH /api/admin/feedback/:id/override-sentiment
exports.overrideSentiment = asyncHandler(async (req, res) => {
    const feedback = await feedbackService.overrideSentiment(req.params.id, req.user, req.validatedBody.sentiment);
    res.status(200).json({ success: true, feedback, message: 'Sentiment overridden' });
});
