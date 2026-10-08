const { asyncHandler, ValidationError } = require('../middleware/error.middleware');
const accountDeletionService = require('../services/accountDeletion.service');

// GET /api/account/deletion — whether deletion is scheduled, and the grace period
exports.getStatus = asyncHandler(async (req, res) => {
    const status = await accountDeletionService.status(req.user._id || req.user.id);
    res.status(200).json({ success: true, ...status });
});


// GET /api/account/deletion/preview — what deleting now would cancel, and when it happens
exports.getPreview = asyncHandler(async (req, res) => {
    const preview = await accountDeletionService.preview(req.user._id || req.user.id);
    res.status(200).json({ success: true, ...preview });
});


// POST /api/account/deletion — cancels upcoming duties, signs out everywhere,
// and deletes the account after the grace period unless they sign in again
exports.requestDeletion = asyncHandler(async (req, res) => {
    const { password, reason } = req.body || {};
    if (!password || typeof password !== 'string') {
        throw new ValidationError('Please enter your password to confirm.');
    }
    const result = await accountDeletionService.request(req.user._id || req.user.id, password, reason, req);
    res.status(200).json({
        success: true,
        message: 'Your account is scheduled for deletion. Sign in again before then to keep it.',
        ...result
    });
});
