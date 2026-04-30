const Hospital = require('../models/Hospital');
const Duty = require('../models/Duty');
const AdminAuthService = require('../services/adminAuth.service');
const adminService = require('../services/admin.service');
const DutyService = require('../services/duty.service');
const { asyncHandler } = require('../middleware/error.middleware');
const notificationEmitter = require('../services/notificationEmitter');
const activityLogEmitter = require('../services/activityLogEmitter');
const MedicalStaff = require('../models/MedicalStaff');
const { normalizeRole } = require('../utils/helpers');
const logger = require('../utils/logger');




// Admin signin - POST /api/admin/signin
exports.adminSignin = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await AdminAuthService.signin(email, password);

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
    const token = req.headers.authorization?.split(' ')[1];
    const userId = req.user?.id || req.user?._id;

    // Log logout before processing
    if (req.user) {
        activityLogEmitter.logUserLogout(req.user, req)
            .catch(err => console.error('Error logging logout:', err));
    }

    const result = await AdminAuthService.logout(token, userId);
    res.status(200).json({
        success: true,
        ...result
    });
});



// show all hospitals GET /api/admin/hospitals
exports.listHospitals = asyncHandler(async (req, res) => {
    const hospitals = await Hospital.find({})
        .populate('user', 'name email')
        .select('hospitalLegalName currentAddress location staffCount user coordinates')
        .sort({ hospitalLegalName: 1 });

    res.status(200).json({
        success: true,
        count: hospitals.length,
        data: hospitals
    });
});



// create duty for hospital from admin panelPOST /api/admin/duties
exports.createDutyForHospital = asyncHandler(async (req, res) => {
    const {
        hospital_id,
        staff_role,
        date,
        end_date,
        start_time,
        end_time,
        urgency,
        description,
        offered_rate,
        is_overnight_duty
    } = req.body;

    if (!hospital_id) {
        return res.status(400).json({ success: false, message: 'hospital_id is required' });
    }

    const hospital = await Hospital.findById(hospital_id)
        .select('hospitalLegalName currentAddress city state pincode coordinates servicesAvailable staffCount isProfileComplete user')
        .populate('user', '_id name');
    if (!hospital) {
        return res.status(404).json({ success: false, message: 'Hospital not found' });
    }

    const dutyData = {
        staffRole: staff_role,
        date,
        endDate: end_date,
        startTime: start_time,
        endTime: end_time,
        urgency,
        description,
        offeredRate: offered_rate,
        isOvernightDuty: is_overnight_duty || false
    };

    // Use the hospital's own user ID so existing service logic works unchanged
    const result = await DutyService.createDuty(dutyData, hospital.user._id);

    // Notify matching staff + hospital (same as hospital flow)
    try {
        const matchingStaff = await MedicalStaff.find({
            jobRole: staff_role,
            isAvailable: true
        }).populate('user', '_id');

        // Filter out staff with null user references and map to user IDs
        const staffUserIds = matchingStaff
            .filter(s => s.user && s.user._id)
            .map(s => s.user._id.toString());

        const hospitalUserId = hospital.user._id.toString();

        await notificationEmitter.emitDutyCreated(result.duty, hospital, staffUserIds, hospitalUserId);

        // Notify all admins if this is an emergency duty
        if (urgency === 'emergency') {
            const admins = await require('../models/User').find({ role: 'admin' }).select('_id');
            if (admins.length) {
                const adminIds = admins.map(a => a._id.toString());
                await notificationEmitter.emitEmergencyAdminAlert(result.duty, hospital, adminIds, 'emergency_created');

                const alertEmail = process.env.ADMIN_LOGIN_ALERT_EMAIL;
                if (alertEmail) {
                    require('../services/email.service').sendEmergencyAdminAlertEmail(
                        alertEmail, 'Admin', result.duty, hospital, 'emergency_created'
                    ).catch(err => logger.error(`Error sending emergency alert email: ${err.message}`));
                }
            }
        }
    } catch (err) {
        logger.error('Admin createDuty: notification error - ' + err.message);
    }

    res.status(201).json({ success: true, duty: result.duty });
});



// GET /api/admin/dashboard-stats - Get dashboard overview statistics
exports.getDashboardStats = asyncHandler(async (req, res) => {
    try {
        const result = await adminService.getDashboardStats();

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
});


// GET /api/admin/staff-stats - Get staff statistics grouped by role
exports.getStaffStatistics = asyncHandler(async (req, res) => {
    try {
        const result = await adminService.getStaffStatistics();

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
});



// GET /api/admin/medical-staff/stats — dashboard stats
exports.getMedicalStaffStats = asyncHandler(async (req, res) => {
    const result = await adminService.getMedicalStaffStats();
    res.status(200).json({ success: true, data: result });
});

// GET /api/admin/medical-staff — paginated list with filters
exports.getMedicalStaffList = asyncHandler(async (req, res) => {
    const { search, role, availability, page, limit } = req.validatedQuery;

    const result = await adminService.getMedicalStaffListWithFilters({
        search,
        role,
        availability,
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
    res.status(200).json({ success: true, message: result.message, data: result });
});


// PATCH /api/admin/medical-staff/:staffId/reject
exports.rejectMedicalStaff = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    const result = await adminService.rejectMedicalStaff(req.params.staffId, reason);
    res.status(200).json({ success: true, message: result.message, data: result });
});



// GET /api/admin/nearby-staff - Get ALL available staff within distance from hospital
exports.getNearbyAvailableStaff = asyncHandler(async (req, res) => {
    // Extract from validated query object (set by middleware)
    const { hospital_id, distance, role } = req.validatedQuery;

    const result = await adminService.getNearbyAvailableStaff(
        hospital_id,
        distance,
        role
    );

    res.status(200).json({
        success: true,
        data: result
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
    const cacheService = require('../services/cache.service');
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
    const documentService = require('../services/document.service');
    const result = await documentService.verifyDocument(req.params.documentId, req.user._id || req.user.id);
    res.status(200).json({ success: true, message: 'Document verified successfully', data: result });
});


// PUT /api/admin/documents/:documentId/reject
exports.rejectDocument = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    const documentService = require('../services/document.service');
    const result = await documentService.rejectDocument(req.params.documentId, req.user._id || req.user.id, reason);
    res.status(200).json({ success: true, message: 'Document rejected', data: result });
});


// GET /api/admin/active-duties - Get active duties with filtering
exports.getActiveDuties = asyncHandler(async (req, res) => {
    // Use validated query parameters from middleware
    const { role, location, status, page, limit } = req.validatedQuery;

    try {
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
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
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
        res.status(error.message.includes('not found') ? 404 : 400).json({
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
    const { search, status, city, page, limit } = req.validatedQuery;
    const result = await adminService.getHospitalList({ search, status, city, page, limit });
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
    res.status(200).json({ success: true, message: 'Hospital verified', data: result });
});


// PATCH /api/admin/hospitals/:hospitalId/reject
exports.rejectHospital = asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    const result = await adminService.rejectHospital(req.params.hospitalId, reason);
    res.status(200).json({ success: true, message: 'Hospital rejected', data: result });
});


// GET /api/admin/overnight-duties - Get live overnight duties
exports.getOvernightDuties = asyncHandler(async (req, res) => {
    try {
        const result = await adminService.getOvernightDuties();

        res.status(200).json({
            success: true,
            data: result.duties,
            count: result.count
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
});


// GET /api/admin/duty-history - Get completed duty history with filters
exports.getDutyHistory = asyncHandler(async (req, res) => {
    const { date, startDate, endDate, hospitalName, page, limit } = req.validatedQuery;

    try {
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
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message
        });
    }
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
