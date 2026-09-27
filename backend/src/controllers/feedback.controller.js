const feedbackService = require('../services/feedback.service');
const { asyncHandler } = require('../middleware/error.middleware');

// POST /api/support/feedback
exports.submit = asyncHandler(async (req, res) => {
    const feedback = await feedbackService.submit(req.user, req.validatedBody);
    res.status(201).json({ success: true, feedback, message: 'Feedback submitted' });
});

// GET /api/support/feedback/mine
exports.listMine = asyncHandler(async (req, res) => {
    const feedback = await feedbackService.listMine(req.user);
    res.status(200).json({ success: true, count: feedback.length, data: feedback });
});
