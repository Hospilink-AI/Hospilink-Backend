const adminManagementService = require('../services/adminManagement.service');
const EmailService = require('../services/email.service');
const { asyncHandler } = require('../middleware/error.middleware');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');


const actorFrom = (req) => ({
    userId: req.user._id || req.user.id,
    name: req.user.name,
    role: 'admin',
    email: req.user.email
});



// POST /api/admin/create-admin
exports.createAdmin = asyncHandler(async (req, res) => {
    const { name, email, password, adminSubRole } = req.validatedBody;

    const admin = await adminManagementService.createAdmin({ name, email, password, adminSubRole });

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ADMIN_CREATED,
        { type: 'admin', id: admin.id, name: admin.name },
        actorFrom(req),
        { newAdminEmail: admin.email, adminSubRole: admin.adminSubRole },
        req
    ).catch(() => {});

    EmailService.sendAdminAccountCreatedAlertEmail(
        admin.name, admin.email, admin.adminSubRole, req.user.name, req.user.email
    ).catch(() => {});

    res.status(201).json({ success: true, message: 'Admin account created successfully', data: admin });
});




// GET /api/admin/admin-list
exports.listAdmins = asyncHandler(async (req, res) => {
    const { adminSubRole, includeInactive, page, limit } = req.validatedQuery;

    const result = await adminManagementService.listAdmins({ adminSubRole, includeInactive, page, limit });

    res.status(200).json({
        success: true,
        data: result.admins,
        pagination: result.pagination
    });
});




// GET /api/admin/admin-detail/:adminId
exports.getAdminDetail = asyncHandler(async (req, res) => {
    const admin = await adminManagementService.getAdminDetail(req.params.adminId);
    res.status(200).json({ success: true, data: admin });
});




// PATCH /api/admin/update-admin-role/:adminId
exports.changeAdminRole = asyncHandler(async (req, res) => {
    const { adminSubRole } = req.validatedBody;
    const requestingAdminId = req.user._id || req.user.id;

    const result = await adminManagementService.changeAdminRole(req.params.adminId, adminSubRole, requestingAdminId);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ADMIN_ROLE_CHANGED,
        { type: 'admin', id: result.id, name: result.name },
        actorFrom(req),
        { previousSubRole: result.previousSubRole, newSubRole: result.newSubRole },
        req
    ).catch(() => {});

    res.status(200).json({ success: true, message: 'Admin sub-role updated successfully', data: result });
});




// DELETE /api/admin/deactivate-admin/:adminId
exports.deactivateAdmin = asyncHandler(async (req, res) => {
    const requestingAdminId = req.user._id || req.user.id;

    const result = await adminManagementService.deactivateAdmin(req.params.adminId, requestingAdminId);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ADMIN_DEACTIVATED,
        { type: 'admin', id: result.id, name: result.name },
        actorFrom(req),
        { deactivatedAdminEmail: result.email },
        req
    ).catch(() => {});

    EmailService.sendAdminAccountDeactivatedAlertEmail(
        result.name, result.email, req.user.name, req.user.email
    ).catch(() => {});

    res.status(200).json({ success: true, message: 'Admin account deactivated successfully', data: result });
});




// PATCH /api/admin/activate-admin/:adminId
exports.activateAdmin = asyncHandler(async (req, res) => {
    const result = await adminManagementService.activateAdmin(req.params.adminId);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ADMIN_ACTIVATED,
        { type: 'admin', id: result.id, name: result.name },
        actorFrom(req),
        { activatedAdminEmail: result.email },
        req
    ).catch(() => {});

    EmailService.sendAdminAccountActivatedAlertEmail(
        result.name, result.email, req.user.name, req.user.email
    ).catch(() => {});

    res.status(200).json({ success: true, message: 'Admin account activated successfully', data: result });
});
