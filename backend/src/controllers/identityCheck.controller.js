const mongoose = require('mongoose');
const identityCheck = require('../services/identityCheck.service');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const { asyncHandler, ValidationError, NotFoundError } = require('../middleware/error.middleware');

const STATUSES = ['flagged', 'dismissed', 'clear'];
const SEVERITIES = ['high', 'low'];
const ROLES = ['staff', 'hospital'];

function userIdParam(req) {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) throw new ValidationError('Invalid user id');
    return userId;
}

// GET /api/admin/identity-checks?status=flagged&severity=high&role=staff&page=1&limit=20
exports.list = asyncHandler(async (req, res) => {
    const { status = 'flagged', severity, role } = req.query;
    if (!STATUSES.includes(status)) throw new ValidationError(`status must be one of ${STATUSES.join(', ')}`);
    if (severity && !SEVERITIES.includes(severity)) throw new ValidationError(`severity must be one of ${SEVERITIES.join(', ')}`);
    if (role && !ROLES.includes(role)) throw new ValidationError(`role must be one of ${ROLES.join(', ')}`);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const result = await identityCheck.list({ status, severity, role, page, limit });
    res.status(200).json({ success: true, data: result.items, pagination: result.pagination });
});

// GET /api/admin/identity-checks/:userId
exports.get = asyncHandler(async (req, res) => {
    const result = await identityCheck.forAdmin(userIdParam(req));
    if (!result) throw new NotFoundError('No doctor or hospital account with that id');
    res.status(200).json({ success: true, data: result });
});

// POST /api/admin/identity-checks/:userId/recheck
exports.recheck = asyncHandler(async (req, res) => {
    const userId = userIdParam(req);
    const checked = await identityCheck.evaluate(userId);
    if (!checked) throw new NotFoundError('No doctor or hospital account with that id');
    res.status(200).json({ success: true, data: await identityCheck.forAdmin(userId) });
});

// POST /api/admin/identity-checks/:userId/dismiss { note }
exports.dismiss = asyncHandler(async (req, res) => {
    const userId = userIdParam(req);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (note.length < 3) throw new ValidationError('Add a short note on why the differences are fine');
    const adminId = req.user._id || req.user.id;
    const dismissed = await identityCheck.dismiss(userId, adminId, note);
    if (!dismissed) throw new NotFoundError('This account has no open identity flag');

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.IDENTITY_FLAG_DISMISSED,
        { type: 'user', id: userId, name: userId },
        { userId: adminId, name: req.user.name, role: 'admin', email: req.user.email },
        { userId, issues: (dismissed.issues || []).map(issue => issue.code) },
        req
    ).catch(() => {});

    res.status(200).json({ success: true, data: await identityCheck.forAdmin(userId) });
});
