const express = require('express');
const router = express.Router();
const chatbotController = require('../controllers/chatbot.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { ticketEvidenceUpload, validateMagicBytes } = require('../middleware/upload.middleware');
const { validateChatbotMessage } = require('../middleware/validation.middleware');

router.use(protect);
router.use(checkSuspension);
router.use(authorize('staff', 'hospital'));

// Declared before the (nonexistent here) '/:id' pattern isn't a concern on
// this router, but kept as a literal route for clarity/consistency with the
// rest of the module's routing conventions.
router.get('/conversations/active', chatbotController.getActiveConversation);

router.post(
    '/message',
    ticketEvidenceUpload.array('files', 5),
    validateMagicBytes,
    validateChatbotMessage,
    chatbotController.sendMessage
);

module.exports = router;
