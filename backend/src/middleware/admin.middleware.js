const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');



// Validate admin signin request
const validateAdminSignin = (req, res, next) => {
    // Check for request body content
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Request body is required'
        });
    }

    const { email, password } = req.body;

    // Validate email
    if (!email) {
        return res.status(400).json({
            success: false,
            message: 'Email is required'
        });
    }

    if (typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({
            success: false,
            message: 'Valid email is required'
        });
    }

    // Validate password
    if (!password) {
        return res.status(400).json({
            success: false,
            message: 'Password is required'
        });
    }

    if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({
            success: false,
            message: 'Password must be at least 6 characters long'
        });
    }

    next();
};


// Validate admin OTP verification request
const validateAdminOTP = (req, res, next) => {
    const { email, otp } = req.body;

    // Validate email
    if (!email) {
        return res.status(400).json({
            success: false,
            message: 'Email is required'
        });
    }

    if (typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({
            success: false,
            message: 'Valid email is required'
        });
    }

    // Validate OTP
    if (!otp) {
        return res.status(400).json({
            success: false,
            message: 'OTP is required'
        });
    }

    if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({
            success: false,
            message: 'OTP must be a 6-digit number'
        });
    }

    next();
};


// Validate admin resend OTP request
const validateAdminResendOTP = (req, res, next) => {
    const { email } = req.body;

    // Validate email
    if (!email) {
        return res.status(400).json({
            success: false,
            message: 'Email is required'
        });
    }

    if (typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({
            success: false,
            message: 'Valid email is required'
        });
    }

    next();
};



// Validate staff duty report query parameters
const validateStaffDutyReportQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // Validate allowed query parameters only
    const allowedParams = ['days', 'role', 'page', 'limit'];
    const receivedParams = Object.keys(req.query);

    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }

    const { days, role, page = 1, limit = 10 } = req.query;

    // Validate days parameter
    const daysNum = days ? parseInt(days) : null;
    if (days && (isNaN(daysNum) || daysNum < 1 || daysNum > 365)) {
        return res.status(400).json({
            success: false,
            message: 'Days parameter must be a positive integer between 1 and 365'
        });
    }

    // Validate role parameter
    if (role && typeof role !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Role parameter must be a string'
        });
    }

    // Validate page parameter
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1) {
        return res.status(400).json({
            success: false,
            message: 'Page parameter must be a positive integer'
        });
    }

    // Validate limit parameter
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
            success: false,
            message: 'Limit parameter must be a positive integer between 1 and 100'
        });
    }

    // Add validated values to request object
    req.validatedQuery = {
        days: daysNum,
        role: role || null,
        page: pageNum,
        limit: limitNum
    };

    next();
};




// Validate nearby staff query parameters
const validateNearbyStaffQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // Validate allowed query parameters only
    const allowedParams = ['hospital_id', 'radius', 'role'];
    const receivedParams = Object.keys(req.query);

    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }

    // Validate hospital_id - required parameter
    if (!req.query.hospital_id) {
        return res.status(400).json({
            success: false,
            message: 'hospital_id is required'
        });
    }

    // Validate hospital_id format
    if (!mongoose.Types.ObjectId.isValid(req.query.hospital_id)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid hospital_id format'
        });
    }

    // Validate radius parameter (1-100 km)
    const radiusNum = parseFloat(req.query.radius) || 10;
    if (isNaN(radiusNum) || radiusNum < 1 || radiusNum > 100) {
        return res.status(400).json({
            success: false,
            message: 'Radius must be a number between 1 and 100 km'
        });
    }

    // Validate role parameter (optional)
    const roleParam = req.query.role || null;
    if (roleParam && typeof roleParam !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Role parameter must be a string'
        });
    }

    // Add validated values to request object
    req.validatedQuery = {
        hospital_id: req.query.hospital_id,
        radius: radiusNum,
        role: roleParam
    };

    next();
};



// Validate active duties query parameters
const validateActiveDutiesQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // Validate allowed query parameters only
    const allowedParams = ['role', 'location', 'page', 'limit', 'status'];
    const receivedParams = Object.keys(req.query);

    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }

    const { role, location, page = 1, limit = 10, status } = req.query;

    // Validate role parameter 
    if (role && typeof role !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Role parameter must be a string'
        });
    }

    // Validate location parameter 
    if (location && typeof location !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Location parameter must be a string'
        });
    }

    // Validate status parameter 
    const allowedStatuses = ['assigned', 'enroute', 'in-progress'];
    if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: `Status parameter must be one of: ${allowedStatuses.join(', ')}`
        });
    }

    // Validate page parameter
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1) {
        return res.status(400).json({
            success: false,
            message: 'Page parameter must be a positive integer'
        });
    }

    // Validate limit parameter
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
            success: false,
            message: 'Limit parameter must be a positive integer between 1 and 100'
        });
    }

    // Add validated values to request object
    req.validatedQuery = {
        role: role || null,
        location: location || null,
        status: status || null,
        page: pageNum,
        limit: limitNum
    };

    next();
};



// Validate duty route map parameters
const validateDutyRouteMap = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use path parameters only.'
        });
    }

    const { dutyId } = req.params;

    // Validate dutyId format
    if (!mongoose.Types.ObjectId.isValid(dutyId)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid duty ID format'
        });
    }

    // Add validated values to request object
    req.validatedParams = {
        dutyId
    };

    next();
};


// Validate overnight duties query parameters
const validateOvernightDutiesQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // No query parameters needed for overnight duties - it returns all live overnight duties
    req.validatedQuery = {};

    next();
};


// Validate duty history query parameters
const validateDutyHistoryQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // Validate allowed query parameters only
    const allowedParams = ['date', 'startDate', 'endDate', 'hospitalName', 'page', 'limit'];
    const receivedParams = Object.keys(req.query);

    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }

    const { date, startDate, endDate, hospitalName, page = 1, limit = 10 } = req.query;

    // Validate date format (DD-MM-YYYY)
    const dateRegex = /^\d{2}-\d{2}-\d{4}$/;

    if (date && !dateRegex.test(date)) {
        return res.status(400).json({
            success: false,
            message: 'Date must be in DD-MM-YYYY format (e.g., 23-10-2025)'
        });
    }

    if (startDate && !dateRegex.test(startDate)) {
        return res.status(400).json({
            success: false,
            message: 'Start date must be in DD-MM-YYYY format (e.g., 23-10-2025)'
        });
    }

    if (endDate && !dateRegex.test(endDate)) {
        return res.status(400).json({
            success: false,
            message: 'End date must be in DD-MM-YYYY format (e.g., 23-10-2025)'
        });
    }

    // Cannot use both single date and date range
    if (date && (startDate || endDate)) {
        return res.status(400).json({
            success: false,
            message: 'Cannot use both single date and date range filters'
        });
    }

    // If using date range, both startDate and endDate are required
    if ((startDate && !endDate) || (!startDate && endDate)) {
        return res.status(400).json({
            success: false,
            message: 'Both startDate and endDate are required for date range filter'
        });
    }

    // Validate hospitalName parameter
    if (hospitalName && typeof hospitalName !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Hospital name parameter must be a string'
        });
    }

    // Validate page parameter
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1) {
        return res.status(400).json({
            success: false,
            message: 'Page parameter must be a positive integer'
        });
    }

    // Validate limit parameter
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
            success: false,
            message: 'Limit parameter must be a positive integer between 1 and 100'
        });
    }

    // Add validated values to request object
    req.validatedQuery = {
        date: date || null,
        startDate: startDate || null,
        endDate: endDate || null,
        hospitalName: hospitalName || null,
        page: pageNum,
        limit: limitNum
    };

    next();
};




// Validate ObjectId parameter
const validateObjectId = (paramName) => {
    return (req, res, next) => {
        const id = req.params[paramName];

        if (!id) {
            return res.status(400).json({
                success: false,
                message: `${paramName} is required`
            });
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: `Invalid ${paramName} format`
            });
        }

        req.validatedParams = req.validatedParams || {};
        req.validatedParams[paramName] = id;

        next();
    };
};



// Validate rejection reason for PATCH endpoints
const validateRejectionReason = (req, res, next) => {
    const { reason } = req.body;

    // Check for unexpected fields
    const allowedFields = ['reason'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid fields: ${unexpectedFields.join(', ')}. Only allowed: reason`
        });
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Rejection reason is required and must be a non-empty string'
        });
    }

    if (reason.length > 500) {
        return res.status(400).json({
            success: false,
            message: 'Rejection reason cannot exceed 500 characters'
        });
    }

    next();
};



// Validate hospital simple list query
const validateHospitalSimpleListQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // Validate allowed query parameters only
    const allowedParams = ['name'];
    const receivedParams = Object.keys(req.query);

    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }

    const { name } = req.query;

    // Validate name parameter (optional)
    if (name && typeof name !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Name parameter must be a string'
        });
    }

    req.validatedQuery = {
        name: name || null
    };

    next();
};



// Validate hospital list query parameters
const validateHospitalListQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // Validate allowed query parameters only
    const allowedParams = ['search', 'status', 'city', 'page', 'limit'];
    const receivedParams = Object.keys(req.query);

    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }

    const { search, status, city, page = 1, limit = 10 } = req.query;

    // Validate status parameter
    const allowedStatuses = ['pending', 'verified', 'rejected'];
    if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: `Status parameter must be one of: ${allowedStatuses.join(', ')}`
        });
    }

    // Validate search parameter
    if (search && typeof search !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Search parameter must be a string'
        });
    }

    // Validate city parameter
    if (city && typeof city !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'City parameter must be a string'
        });
    }

    // Validate page parameter
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1) {
        return res.status(400).json({
            success: false,
            message: 'Page parameter must be a positive integer'
        });
    }

    // Validate limit parameter
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
            success: false,
            message: 'Limit parameter must be a positive integer between 1 and 100'
        });
    }

    req.validatedQuery = {
        search: search || null,
        status: status || null,
        city: city || null,
        page: pageNum,
        limit: limitNum
    };

    next();
};



// Validate medical staff list query parameters
const validateMedicalStaffListQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // Validate allowed query parameters only
    const allowedParams = ['search', 'role', 'availability', 'status', 'page', 'limit'];
    const receivedParams = Object.keys(req.query);

    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }

    const { search, role, availability, status, page = 1, limit = 10 } = req.query;

    // Validate role parameter
    const allowedRoles = [
        'rmo', 'dmo', 'general_physician', 'intensivist', 'emergency_doctor',
        'anesthetist', 'pediatrician', 'gynecologist', 'orthopedic_surgeon',
        'general_surgeon', 'radiologist', 'pathologist', 'staff_nurse',
        'icu_nurse', 'emergency_nurse', 'ot_nurse', 'dialysis_nurse', 'nicu_nurse',
        'lab_technician', 'radiology_technician', 'ot_technician', 'dialysis_technician',
        'cath_lab_technician', 'icu_technician', 'ward_boy', 'ayah', 'opd_attendant',
        'emergency_attendant', 'patient_care_taker', 'pharmacist', 'pharmacy_assistant',
        'biomedical_engineer', 'housekeeping_staff', 'security_guard', 'ambulance_driver',
        'receptionist', 'billing_executive', 'medical_records_staff', 'hr_accounts'
    ];
    if (role && !allowedRoles.includes(role)) {
        return res.status(400).json({
            success: false,
            message: `Role parameter must be one of: ${allowedRoles.join(', ')}`
        });
    }

    // Validate availability parameter
    const allowedAvailability = ['available', 'unavailable', 'on-duty'];
    if (availability && !allowedAvailability.includes(availability)) {
        return res.status(400).json({
            success: false,
            message: `Availability parameter must be one of: ${allowedAvailability.join(', ')}`
        });
    }

    // Validate status parameter
    const allowedStatuses = ['pending', 'verified', 'rejected'];
    if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: `Status parameter must be one of: ${allowedStatuses.join(', ')}`
        });
    }

    // Validate search parameter
    if (search && typeof search !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Search parameter must be a string'
        });
    }

    // Validate page parameter
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1) {
        return res.status(400).json({
            success: false,
            message: 'Page parameter must be a positive integer'
        });
    }

    // Validate limit parameter
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
            success: false,
            message: 'Limit parameter must be a positive integer between 1 and 100'
        });
    }

    req.validatedQuery = {
        search: search || null,
        role: role || null,
        availability: availability || null,
        status: status || null,
        page: pageNum,
        limit: limitNum
    };

    next();
};



// Validate medical staff list query parameters (verified staff only)
const validateMedicalStaffListVerified = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }
 
    // Validate allowed query parameters only
    const allowedParams = ['city', 'jobRole', 'page', 'limit'];
    const receivedParams = Object.keys(req.query);
 
    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }
 
    const { city, jobRole, page = 1, limit = 10 } = req.query;
 
    // Validate city parameter (optional)
    if (city && typeof city !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'City parameter must be a string'
        });
    }
 
    // Validate jobRole parameter (optional)
    const allowedRoles = [
        'rmo', 'dmo', 'general_physician', 'intensivist', 'emergency_doctor',
        'anesthetist', 'pediatrician', 'gynecologist', 'orthopedic_surgeon',
        'general_surgeon', 'radiologist', 'pathologist', 'staff_nurse',
        'icu_nurse', 'emergency_nurse', 'ot_nurse', 'dialysis_nurse', 'nicu_nurse',
        'lab_technician', 'radiology_technician', 'ot_technician', 'dialysis_technician',
        'cath_lab_technician', 'icu_technician', 'ward_boy', 'ayah', 'opd_attendant',
        'emergency_attendant', 'patient_care_taker', 'pharmacist', 'pharmacy_assistant',
        'biomedical_engineer', 'housekeeping_staff', 'security_guard', 'ambulance_driver',
        'receptionist', 'billing_executive', 'medical_records_staff', 'hr_accounts'
    ];
    if (jobRole && !allowedRoles.includes(jobRole)) {
        return res.status(400).json({
            success: false,
            message: `Job role parameter must be one of: ${allowedRoles.join(', ')}`
        });
    }
 
    // Validate page parameter
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1) {
        return res.status(400).json({
            success: false,
            message: 'Page parameter must be a positive integer'
        });
    }
 
    // Validate limit parameter
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
            success: false,
            message: 'Limit parameter must be a positive integer between 1 and 100'
        });
    }
 
    req.validatedQuery = {
        city: city || null,
        jobRole: jobRole || null,
        page: pageNum,
        limit: limitNum
    };
 
    next();
};


// Validate documents list query parameters
const validateDocumentsListQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // Validate allowed query parameters only
    const allowedParams = ['status', 'userRole', 'page', 'limit', 'sortBy', 'sortOrder'];
    const receivedParams = Object.keys(req.query);

    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }

    const { status, userRole, page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    // Validate status parameter
    const allowedStatuses = ['pending', 'verified', 'rejected', 'auto-verified', 'manual-pending-verification'];
    if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: `Status parameter must be one of: ${allowedStatuses.join(', ')}`
        });
    }

    // Validate userRole parameter
    const allowedUserRoles = ['staff', 'hospital'];
    if (userRole && !allowedUserRoles.includes(userRole)) {
        return res.status(400).json({
            success: false,
            message: `User role parameter must be one of: ${allowedUserRoles.join(', ')}`
        });
    }

    // Validate sortBy parameter
    const allowedSortBy = ['createdAt', 'updatedAt', 'documentType', 'status'];
    if (!allowedSortBy.includes(sortBy)) {
        return res.status(400).json({
            success: false,
            message: `Sort by parameter must be one of: ${allowedSortBy.join(', ')}`
        });
    }

    // Validate sortOrder parameter
    const allowedSortOrder = ['asc', 'desc'];
    if (!allowedSortOrder.includes(sortOrder)) {
        return res.status(400).json({
            success: false,
            message: `Sort order parameter must be one of: ${allowedSortOrder.join(', ')}`
        });
    }

    // Validate page parameter
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1) {
        return res.status(400).json({
            success: false,
            message: 'Page parameter must be a positive integer'
        });
    }

    // Validate limit parameter
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
            success: false,
            message: 'Limit parameter must be a positive integer between 1 and 100'
        });
    }

    req.validatedQuery = {
        status: status || null,
        userRole: userRole || null,
        page: pageNum,
        limit: limitNum,
        sortBy,
        sortOrder
    };

    next();
};
// Validate admin assign duty request
const validateAssignDuty = (req, res, next) => {
    const { hospital_id, duty_id, staff_id } = req.body;

    //  Body check
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Request body is required'
        });
    }

    //  Required fields
    if (!hospital_id || !duty_id || !staff_id) {
        return res.status(400).json({
            success: false,
            message: 'hospital_id, duty_id and staff_id are required'
        });
    }

    //  ObjectId validation
    if (!mongoose.Types.ObjectId.isValid(hospital_id)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid hospital_id format'
        });
    }

    if (!mongoose.Types.ObjectId.isValid(duty_id)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid duty_id format'
        });
    }

    if (!mongoose.Types.ObjectId.isValid(staff_id)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid staff_id format'
        });
    }

    req.validatedBody = {
        hospital_id,
        duty_id,
        staff_id
    };

    next();
};


module.exports = {
    validateAdminSignin,
    validateAdminOTP,
    validateAdminResendOTP,
    validateStaffDutyReportQuery,
    validateNearbyStaffQuery,
    validateActiveDutiesQuery,
    validateDutyRouteMap,
    validateOvernightDutiesQuery,
    validateDutyHistoryQuery,
    validateHospitalSimpleListQuery,
    validateHospitalListQuery,
    validateMedicalStaffListQuery,
    validateMedicalStaffListVerified,
    validateDocumentsListQuery,
    validateObjectId,
    validateRejectionReason,
    validateAssignDuty
};