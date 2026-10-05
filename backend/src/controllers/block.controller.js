const { asyncHandler } = require('../middleware/error.middleware');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const blockService = require('../services/block.service');
const contentReportService = require('../services/contentReport.service');

// GET /api/blocks — the accounts this doctor or hospital has blocked
exports.listBlocked = asyncHandler(async (req, res) => {
    const blocked = req.user.role === 'hospital'
        ? await blockService.listForHospital(req.user.id)
        : await blockService.listForStaff(req.user.id);
    res.status(200).json({ success: true, blocked });
});


// POST /api/blocks/hospitals/:hospitalId (doctor)
exports.blockHospital = asyncHandler(async (req, res) => {
    const result = await blockService.blockHospital(req.user.id, req.params.hospitalId);
    activityLogEmitter.logAction(ACTIVITY_ACTIONS.USER_BLOCKED, req, { type: 'hospital', id: result.blocked.id, name: result.blocked.name }).catch(() => {});
    res.status(200).json({ success: true, message: 'Hospital blocked', ...result });
});


// DELETE /api/blocks/hospitals/:hospitalId (doctor)
exports.unblockHospital = asyncHandler(async (req, res) => {
    await blockService.unblockHospital(req.user.id, req.params.hospitalId);
    activityLogEmitter.logAction(ACTIVITY_ACTIONS.USER_UNBLOCKED, req, { type: 'hospital', id: req.params.hospitalId }).catch(() => {});
    res.status(200).json({ success: true, message: 'Hospital unblocked' });
});


// POST /api/blocks/staff/:staffId (hospital)
exports.blockStaff = asyncHandler(async (req, res) => {
    const result = await blockService.blockStaff(req.user.id, req.params.staffId);
    activityLogEmitter.logAction(ACTIVITY_ACTIONS.USER_BLOCKED, req, { type: 'staff', id: result.blocked.id, name: result.blocked.name }).catch(() => {});
    res.status(200).json({ success: true, message: 'Doctor blocked', ...result });
});


// DELETE /api/blocks/staff/:staffId (hospital)
exports.unblockStaff = asyncHandler(async (req, res) => {
    await blockService.unblockStaff(req.user.id, req.params.staffId);
    activityLogEmitter.logAction(ACTIVITY_ACTIONS.USER_UNBLOCKED, req, { type: 'staff', id: req.params.staffId }).catch(() => {});
    res.status(200).json({ success: true, message: 'Doctor unblocked' });
});


// POST /api/reviews/:id/report — opens a support ticket about the review
exports.reportReview = asyncHandler(async (req, res) => {
    const ticket = await contentReportService.reportReview(req.user, req.params.id, req.body?.reason);
    res.status(201).json({ success: true, message: 'Thanks, our team will look into it', ticket });
});
