const feedbackService = require('../services/feedback.service');
const { asyncHandler } = require('../middleware/error.middleware');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');

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
    activityLogEmitter.logAction(ACTIVITY_ACTIONS.FEEDBACK_SENTIMENT_OVERRIDDEN, req, { type: 'feedback', id: req.params.id, name: 'Platform feedback' }, { sentiment: req.validatedBody.sentiment }).catch(() => {});
    res.status(200).json({ success: true, feedback, message: 'Sentiment overridden' });
});
