const chatbotIntakeService = require('../services/chatbotIntake.service');
const { asyncHandler } = require('../middleware/error.middleware');

// POST /api/chatbot/message
exports.sendMessage = asyncHandler(async (req, res) => {
    const conversation = await chatbotIntakeService.sendMessage(req.user, { ...req.validatedBody, files: req.files || [] });
    res.status(200).json({ success: true, conversation });
});

// GET /api/chatbot/conversations/active
exports.getActiveConversation = asyncHandler(async (req, res) => {
    const conversation = await chatbotIntakeService.getActiveConversation(req.user);
    res.status(200).json({ success: true, conversation });
});
