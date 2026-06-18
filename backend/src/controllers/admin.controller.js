const Hospital = require('../models/Hospital');
const Duty = require('../models/Duty');
const User = require('../models/User')
const AdminAuthService = require('../services/adminAuth.service');
const adminService = require('../services/admin.service');
const DutyService = require('../services/duty.service');
const documentService = require('../services/document.service');
const { asyncHandler } = require('../middleware/error.middleware');
const notificationEmitter = require('../services/notificationEmitter');
const activityLogEmitter = require('../services/activityLogEmitter');
const MedicalStaff = require('../models/MedicalStaff');
const { normalizeRole } = require('../utils/helpers');
const logger = require('../utils/logger');
const cacheService = require('../services/cache.service');
const { generateActiveDutiesPDF } = require('../utils/pdf.puppeteer');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');



// Admin signin - POST /api/admin/signin
exports.adminSignin = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await AdminAuthService.signin(email, password);

    // Log admin login
    if (result.admin || result.user) {
        const admin = result.admin || result.user;
        activityLogEmitter.emitAdminActivity(
            ACTIVITY_ACTIONS.ADMIN_LOGIN,
            null,
            { userId: admin._id || admin.id, name: admin.name, role: 'admin', email: admin.email },
            { email: admin.email },
            req
        ).catch(() => { });
    }

    res.status(200).json({
        success: true,
        ...result
    });
});


// Admin OTP verification - POST /api/admin/verify-otp
exports.adminVerifyOTP = asyncHandler(async (req, res) => {
    const { email, otp } = req.body;
    const result = await AdminAuthService.verifyOTP(email, otp, req);

    res.status(200).json({
        success: true,
        ...result
    });
});


// Admin resend OTP - POST /api/admin/resend-otp
exports.adminResendOTP = asyncHandler(async (req, res) => {
    const { email } = req.body;
    const result = await AdminAuthService.resendOTP(email);

    res.status(200).json({
        success: true,
        ...result
    });
});



// Admin logout - POST /api/admin/logout
exports.adminLogout = asyncHandler(async (req, res) => {
    const token = req.headers.authorization.split(' ')[1];
    const userId = req.user?.id || req.user?._id;

    const result = await AdminAuthService.logout(token, userId);

    if (req.user) {
        activityLogEmitter.logUserLogout(req.user, req)
            .catch(err => console.error('Error logging logout:', err));
    }

    res.status(200).json({ success: true, ...result });
});



// Create duty for hospital from admin panel
// POST /api/admin/duties
exports.createDutyForHospital = asyncHandler(async (req, res) => {
    const { hospital_id } = req.body;

    if (!hospital_id) {
        return res.status(400).json({ success: false, message: 'hospital_id is required' });
    }

    const result = await adminService.createDutyForHospital(hospital_id, req.body);

    res.status(201).json(result);
});



// GET /api/admin/dashboard-stats - Get dashboard overview statistics
exports.getDashboardStats = asyncHandler(async (req, res) => {
    const result = await adminService.getDashboardStats();

    res.status(200).json({
        success: true,
        data: result
    });
});


// GET /api/admin/hospitals/stats — dashboard stats for hospital management
exports.getHospitalStats = asyncHandler(async (req, res) => {
    const result = await adminService.getHospitalStats();
    res.status(200).json({ success: true, data: result });
});


// GET /api/admin/staff-stats - Get staff statistics grouped by role
exports.getStaffStatistics = asyncHandler(async (req, res) => {
    const result = await adminService.getStaffStatistics();

    res.status(200).json({
        success: true,
        data: result
    });
});



// GET /api/admin/medical-staff/stats — dashboard stats
exports.getMedicalStaffStats = asyncHandler(async (req, res) => {
    const result = await adminService.getMedicalStaffStats();
    res.status(200).json({ success: true, data: result });
});

// GET /api/admin/medical-staff — paginated list with filters
exports.getMedicalStaffList = asyncHandler(async (req, res) => {
    const { search, role, availability, status, location, page, limit } = req.validatedQuery;

    const result = await adminService.getMedicalStaffListWithFilters({
        search,
        role,
        availability,
        status,
        location,
        page,
        limit
    });

    res.status(200).json({
        success: true,
        ...result
    });
});



// GET /api/admin/medical-staff-list — verified staff list with city and jobRole filters
exports.getVerifiedMedicalStaffList = asyncHandler(async (req, res) => {
    const { city, jobRole, page, limit } = req.validatedQuery;

    const result = await adminService.getVerifiedMedicalStaffList({
        city,
        jobRole,
        page,
        limit
    });

    res.status(200).json({
        success: true,
        ...result
    });
});



// GET /api/admin/medical-staff/:staffId — detailed view
exports.getMedicalStaffDetail = asyncHandler(async (req, res) => {
    const result = await adminService.getMedicalStaffDetail(req.params.staffId);
    res.status(200).json({ success: true, data: result });
});


// PATCH /api/admin/medical-staff/:staffId/verify
exports.verifyMedicalStaff = asyncHandler(async (req, res) => {
    const result = await adminService.verifyMedicalStaff(req.params.staffId);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.USER_APPROVED,
        { type: 'staff', id: req.params.staffId, name: result.staff?.fullName || req.params.staffId },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { staffId: req.params.staffId },
        req
    ).catch(() => { });

    res.status(200).json({ success: true, message: result.message, data: result });
});


// PATCH /api/admin/medical-staff/:staffId/reject
exports.rejectMedicalStaff = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    const result = await adminService.rejectMedicalStaff(req.params.staffId, reason);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.USER_REJECTED,
        { type: 'staff', id: req.params.staffId, name: result.staff?.fullName || req.params.staffId },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { staffId: req.params.staffId, reason },
        req
    ).catch(() => { });

    res.status(200).json({ success: true, message: result.message, data: result });
});

// PATCH /api/admin/medical-staff/:staffId/suspend
exports.suspendMedicalStaff = asyncHandler(async (req, res) => {
    const { reason } = req.body;

    if (!reason) {
        return res.status(400).json({
            success: false,
            message: 'Suspension reason is required'
        });
    }

    const result = await adminService.suspendMedicalStaff(
        req.params.staffId,
        reason
    );

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ACCOUNT_SUSPENDED,
        {
            type: 'staff',
            id: req.params.staffId
        },
        {
            userId: req.user._id || req.user.id,
            name: req.user.name,
            role: 'admin',
            email: req.user.email
        },
        {
            staffId: req.params.staffId,
            reason
        },
        req
    ).catch(() => { });

    res.status(200).json({
        success: true,
        message: 'Staff account suspended',
        data: result
    });
});


// PATCH /api/admin/medical-staff/:staffId/unsuspend
exports.unsuspendMedicalStaff = asyncHandler(async (req, res) => {

    const result = await adminService.unsuspendMedicalStaff(
        req.params.staffId
    );

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ACCOUNT_ACTIVATED,
        {
            type: 'staff',
            id: req.params.staffId
        },
        {
            userId: req.user._id || req.user.id,
            name: req.user.name,
            role: 'admin',
            email: req.user.email
        },
        {
            staffId: req.params.staffId
        },
        req
    ).catch(() => { });

    res.status(200).json({
        success: true,
        message: 'Staff account unsuspended',
        data: result
    });
});



// GET /api/admin/nearby-staff - Get ALL available staff within radius from hospital
exports.getNearbyAvailableStaff = asyncHandler(async (req, res) => {
    // Extract from validated query object (set by middleware)
    const { hospital_id, radius, role } = req.validatedQuery;

    const result = await adminService.getNearbyAvailableStaff(
        hospital_id,
        radius,
        role
    );

    res.status(200).json({
        success: true,
        ...result
    });
});


// GET /api/admin/profile
exports.getAdminProfile = asyncHandler(async (req, res) => {
    const user = req.user;

    if (!user) {
        return res.status(404).json({
            success: false,
            message: 'Admin not found'
        });
    }

    res.status(200).json({
        success: true,
        data: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
        }
    });
});


// POST /api/admin/flush-sessions
exports.flushUserSessions = asyncHandler(async (req, res) => {
    const count = await cacheService.invalidatePattern('session:*');
    res.status(200).json({ success: true, message: `Flushed ${count} cached sessions.` });
});


// GET /api/admin/documents
exports.getAllDocuments = asyncHandler(async (req, res) => {
    const { status, userRole, page, limit, sortBy, sortOrder } = req.validatedQuery;
    const result = await adminService.getAllDocuments({ status, userRole, page, limit, sortBy, sortOrder });
    res.status(200).json({ success: true, ...result });
});


// GET /api/admin/documents/stats
exports.getDocumentStats = asyncHandler(async (req, res) => {
    const result = await adminService.getDocumentStats();
    res.status(200).json({ success: true, data: result });
});


// PUT /api/admin/documents/:documentId/verify
exports.verifyDocument = asyncHandler(async (req, res) => {
    const result = await documentService.verifyDocument(req.params.documentId, req.user._id || req.user.id);

    activityLogEmitter.emitDocumentActivity(
        ACTIVITY_ACTIONS.DOCUMENT_VERIFIED_BY_ADMIN,
        { _id: req.params.documentId, documentType: result.documentType, verificationStatus: 'verified' },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { targetUserId: result.userId, targetUserName: result.userName },
        req
    ).catch(() => { });

    res.status(200).json({ success: true, message: 'Document verified successfully', data: result });
});


// PUT /api/admin/documents/:documentId/reject
exports.rejectDocument = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    const result = await documentService.rejectDocument(req.params.documentId, req.user._id || req.user.id, reason);

    activityLogEmitter.emitDocumentActivity(
        ACTIVITY_ACTIONS.DOCUMENT_REJECTED_BY_ADMIN,
        { _id: req.params.documentId, documentType: result.documentType, verificationStatus: 'rejected' },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { targetUserId: result.userId, targetUserName: result.userName, reason },
        req
    ).catch(() => { });

    res.status(200).json({ success: true, message: 'Document rejected successfully', data: result });
});


// GET /api/admin/active-duties - Get active duties with filtering
exports.getActiveDuties = asyncHandler(async (req, res) => {
    // Use validated query parameters from middleware
    const { role, location, status, page, limit } = req.validatedQuery;

    const result = await adminService.getActiveDuties({
        role,
        location,
        status,
        page,
        limit
    });

    res.status(200).json({
        success: true,
        data: result.duties,
        pagination: result.pagination,
        filters: result.filters,
        summary: result.summary
    });
});


// GET /api/admin/active-duties/export - Export active duties as CSV or PDF
exports.exportActiveDuties = asyncHandler(async (req, res) => {
    const format = (req.query.format || 'csv').toLowerCase();

    if (!['csv', 'pdf'].includes(format)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid format. Supported: csv, pdf'
        });
    }

    const { role, location, status } = req.query;

    // Fetch all matching duties without pagination
    const result = await adminService.getActiveDuties({
        role: role || null,
        location: location || null,
        status: status || null,
        page: 1,
        limit: 10000
    });

    const duties = result.duties || [];

    if (duties.length === 0) {
        return res.status(404).json({
            success: false,
            message: 'No active duties found to export'
        });
    }

    const exportedAt = new Date().toISOString();

    // ── CSV ──────────────────────────────────────────────────────────────────
    if (format === 'csv') {
        const headers = [
            'Hospital',
            'City',
            'Role',
            'Staff Name',
            'Staff Email',
            'Date',
            'Start Time',
            'End Time',
            'Status',
            'Urgency',
            'Distance',
            'ETA',
            'Offered Rate'
        ];

        const rows = duties.map(d => [
            d.hospital?.name || '',
            d.hospital?.city || '',
            (d.role || '').replace(/_/g, ' ').toUpperCase(),
            d.staff?.name || '',
            d.staff?.email || '',
            d.timing?.date ? new Date(d.timing.date).toLocaleDateString('en-IN') : '',
            d.timing?.startTime || '',
            d.timing?.endTime || '',
            (d.status?.status || '').toUpperCase(),
            (d.timing?.urgency || '').toUpperCase(),
            d.distance?.distanceText || '',
            d.distance?.estimatedTimeText || '',
            d.offeredRate ? `₹${d.offeredRate}` : ''
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=active-duties-${Date.now()}.csv`);
        return res.status(200).send(csvContent);
    }

    // ── PDF ──────────────────────────────────────────────────────────────────
    return generateActiveDutiesPDF(res, {
        duties,
        filters: result.filters,
        summary: result.summary,
        exportedAt
    });
});



// GET /api/admin/duty-route-map/:dutyId - Get duty route map with polyline
exports.getDutyRouteMap = asyncHandler(async (req, res) => {
    const { dutyId } = req.validatedParams;

    try {
        // Add request tracking for analytics
        const startTime = Date.now();

        const routeMap = await adminService.getDutyRouteMap(dutyId);

        // Log performance metrics
        const responseTime = Date.now() - startTime;
        console.log(`Duty route map generated in ${responseTime}ms for duty: ${dutyId}`);

        // Enhanced response with metadata
        res.status(200).json({
            success: true,
            data: routeMap,
            meta: {
                responseTime: `${responseTime}ms`,
                timestamp: new Date(),
                apiVersion: 'v2.0'
            }
        });
    } catch (error) {
        console.error(`Error in getDutyRouteMap for duty ${dutyId}:`, error);

        // Enhanced error response
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message,
            code: error.code || 'DUTY_ROUTE_MAP_ERROR',
            meta: {
                dutyId,
                timestamp: new Date()
            }
        });
    }
});



// GET /api/admin/hospitals/list — simple list
exports.getHospitalSimpleList = asyncHandler(async (req, res) => {
    const { name } = req.validatedQuery;
    const result = await adminService.getHospitalSimpleList(name);
    res.status(200).json({ success: true, data: result });
});


// GET /api/admin/hospitals — paginated + filtered
exports.listHospitals = asyncHandler(async (req, res) => {
    const { search, status, city, location, page, limit } = req.validatedQuery;
    const result = await adminService.getHospitalList({ search, status, city, location, page, limit });
    res.status(200).json({ success: true, ...result });
});


// GET /api/admin/hospitals/:hospitalId — preview modal
exports.getHospitalDetail = asyncHandler(async (req, res) => {
    const result = await adminService.getHospitalDetail(req.params.hospitalId);
    res.status(200).json({ success: true, data: result });
});


// PATCH /api/admin/hospitals/:hospitalId/verify
exports.verifyHospital = asyncHandler(async (req, res) => {
    const result = await adminService.verifyHospital(req.params.hospitalId);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.USER_APPROVED,
        { type: 'hospital', id: req.params.hospitalId, name: result.hospital?.hospitalLegalName || req.params.hospitalId },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { hospitalId: req.params.hospitalId },
        req
    ).catch(() => { });

    res.status(200).json({ success: true, message: 'Hospital verified successfully', data: result });
});


// PATCH /api/admin/hospitals/:hospitalId/reject
exports.rejectHospital = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    const result = await adminService.rejectHospital(req.params.hospitalId, reason);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.USER_REJECTED,
        { type: 'hospital', id: req.params.hospitalId, name: result.hospital?.hospitalLegalName || req.params.hospitalId },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { hospitalId: req.params.hospitalId, reason },
        req
    ).catch(() => { });

    res.status(200).json({ success: true, message: 'Hospital rejected', data: result });
});

// PATCH /api/admin/hospitals/:hospitalId/suspend
exports.suspendHospital = asyncHandler(async (req, res) => {
    const { reason } = req.body;

    if (!reason) {
        return res.status(400).json({
            success: false,
            message: 'Suspension reason is required'
        });
    }

    const result = await adminService.suspendHospital(
        req.params.hospitalId,
        reason
    );

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ACCOUNT_SUSPENDED,
        {
            type: 'hospital',
            id: req.params.hospitalId
        },
        {
            userId: req.user._id || req.user.id,
            name: req.user.name,
            role: 'admin',
            email: req.user.email
        },
        {
            hospitalId: req.params.hospitalId,
            reason
        },
        req
    ).catch(() => { });

    res.status(200).json({
        success: true,
        message: 'Hospital account suspended',
        data: result
    });
});


// PATCH /api/admin/hospitals/:hospitalId/unsuspend
exports.unsuspendHospital = asyncHandler(async (req, res) => {

    const result = await adminService.unsuspendHospital(
        req.params.hospitalId
    );

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ACCOUNT_ACTIVATED,
        {
            type: 'hospital',
            id: req.params.hospitalId
        },
        {
            userId: req.user._id || req.user.id,
            name: req.user.name,
            role: 'admin',
            email: req.user.email
        },
        {
            hospitalId: req.params.hospitalId
        },
        req
    ).catch(() => { });

    res.status(200).json({
        success: true,
        message: 'Hospital account unsuspended',
        data: result
    });
});

// GET /api/admin/overnight-duties - Get live overnight duties
exports.getOvernightDuties = asyncHandler(async (req, res) => {
    const result = await adminService.getOvernightDuties();

    res.status(200).json({
        success: true,
        data: result.duties,
        count: result.count
    });
});


// GET /api/admin/duty-history - Get completed duty history with filters
exports.getDutyHistory = asyncHandler(async (req, res) => {
    const { date, startDate, endDate, hospitalName, page, limit } = req.validatedQuery;

    const result = await adminService.getDutyHistory({
        date,
        startDate,
        endDate,
        hospitalName,
        page,
        limit
    });

    res.status(200).json({
        success: true,
        data: result.duties,
        pagination: result.pagination,
        filters: result.filters
    });
});


// GET /api/admin/emergency-dashboard - Consolidated Critical + High priority duties list
exports.getEmergencyDashboard = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const result = await DutyService.getEmergencyDashboard({ page, limit });

    res.status(200).json({
        success: true,
        data: result.duties,
        pagination: result.pagination
    });
});


// POST /api/admin/assign-duty
exports.assignDutyToStaff = asyncHandler(async (req, res) => {
    const { hospital_id, duty_id, staff_id } = req.body;

    if (!hospital_id || !duty_id || !staff_id) {
        return res.status(400).json({
            success: false,
            message: 'hospital_id, duty_id and staff_id are required'
        });
    }

    const duty = await DutyService.assignDutyByAdmin({
        hospitalId: hospital_id,
        dutyId: duty_id,
        staffId: staff_id,
        adminId: req.user._id || req.user.id
    });

    res.status(200).json({
        success: true,
        message: 'Duty assigned successfully',
        data: duty
    });
});

// PATCH /api/admin/hospitals/:hospitalId/suspend
exports.suspendHospital = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Suspension reason is required' });

    const result = await adminService.suspendHospital(req.params.hospitalId, reason);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ACCOUNT_SUSPENDED,
        { type: 'hospital', id: req.params.hospitalId },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { hospitalId: req.params.hospitalId, reason },
        req
    ).catch(() => {});

    res.status(200).json({ success: true, message: result.message, data: result });
});


// PATCH /api/admin/hospitals/:hospitalId/unsuspend
exports.unsuspendHospital = asyncHandler(async (req, res) => {
    const result = await adminService.unsuspendHospital(req.params.hospitalId);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ACCOUNT_ACTIVATED,
        { type: 'hospital', id: req.params.hospitalId },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { hospitalId: req.params.hospitalId },
        req
    ).catch(() => {});

    res.status(200).json({ success: true, message: result.message, data: result });
});


// PATCH /api/admin/medical-staff/:staffId/suspend
exports.suspendMedicalStaff = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Suspension reason is required' });

    const result = await adminService.suspendMedicalStaff(req.params.staffId, reason);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ACCOUNT_SUSPENDED,
        { type: 'staff', id: req.params.staffId },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { staffId: req.params.staffId, reason },
        req
    ).catch(() => {});

    res.status(200).json({ success: true, message: result.message, data: result });
});


// PATCH /api/admin/medical-staff/:staffId/unsuspend
exports.unsuspendMedicalStaff = asyncHandler(async (req, res) => {
    const result = await adminService.unsuspendMedicalStaff(req.params.staffId);

    activityLogEmitter.emitAdminActivity(
        ACTIVITY_ACTIONS.ACCOUNT_ACTIVATED,
        { type: 'staff', id: req.params.staffId },
        { userId: req.user._id || req.user.id, name: req.user.name, role: 'admin', email: req.user.email },
        { staffId: req.params.staffId },
        req
    ).catch(() => {});

    res.status(200).json({ success: true, message: result.message, data: result });
});
