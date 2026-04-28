const validator = require('validator');
const { body, validationResult } = require('express-validator');
const { ValidationError } = require('./error.middleware');
const { getCurrentIST, toIST } = require('../utils/helpers');
const { INDIAN_STATES } = require('../utils/constants');


const validateSignup = (req, res, next) => {
    const { name, email, role, password } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['name', 'email', 'role', 'password'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    // Name validation
    if (!name || name.trim().length === 0) {
        errors.push('Name is required');
    } else if (name.length > 50) {
        errors.push('Name cannot exceed 50 characters');
    }

    // Email validation
    if (!email || !validator.isEmail(email)) {
        errors.push('Valid email is required');
    }

    // Password validation
    if (!password) {
        errors.push('Password is required');
    } else if (password.length < 6) {
        errors.push('Password must be at least 6 characters long');
    } else if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
        errors.push('Password must contain at least one uppercase letter, one lowercase letter, and one number');
    }

    // Role validation
    const validRoles = ['admin', 'hospital', 'candidate', 'staff'];
    if (!role || !validRoles.includes(role)) {
        errors.push('Valid role is required');
    }

    if (errors.length > 0) {
        return res.status(400).json({  
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }

    next();
};


const validateOTP = (req, res, next) => {
    const { email, otp } = req.body;
    const errors = [];


    // Check for unexpected fields
    const allowedFields = ['email', 'otp'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }


    if (!email || !validator.isEmail(email)) {
        errors.push('Valid email is required');
    }

    if (!otp || !/^\d{6}$/.test(otp)) {
        errors.push('Valid 6-digit OTP is required');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};


const validateResendOTP = (req, res, next) => {
    const { email } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['email'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    if (!email || !validator.isEmail(email)) {
        errors.push('Valid email is required');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};


const validateSignin = (req, res, next) => {
    const { email, password } = req.body;
    const errors = [];


    // check for unexpected fields
    const allowedFields = ['email', 'password'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }


    if (!email || !validator.isEmail(email)) {
        errors.push('Valid email is required');
    }

    if (!password) {
        errors.push('Password is required');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};



const validateForgotPassword = (req, res, next) => {
    const { email } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['email'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    if (!email || !validator.isEmail(email)) {
        errors.push('Valid email is required');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};



const validateResetPassword = (req, res, next) => {
    const { token, newPassword, confirmPassword } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['token', 'newPassword', 'confirmPassword'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    // Token validation
    if (!token || token.trim().length === 0) {
        errors.push('Reset token is required');
    } else if (token.length < 10) {
        errors.push('Invalid reset token format');
    }

    // New password validation 
    if (!newPassword) {
        errors.push('New password is required');
    } else if (newPassword.length < 6) {
        errors.push('Password must be at least 6 characters long');
    } else if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword)) {
        errors.push('Password must contain at least one uppercase letter, one lowercase letter, and one number');
    }

    // Confirm password validation
    if (!confirmPassword) {
        errors.push('Confirm password is required');
    } else if (newPassword && confirmPassword !== newPassword) {
        errors.push('Passwords do not match');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};



const validateMedicalStaffProfile = (req, res, next) => {
    const { fullName, jobRole, city, area, phoneNumber} = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = [
        'fullName',
        'jobRole',
        'city',
        'area',
        'phoneNumber',
        'profileSummary',
        'education',
        'skills'
    ];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    // Full name validation
    if (!fullName || fullName.trim().length === 0) {
        errors.push('Full name is required');
    } else if (fullName.length > 100) {
        errors.push('Full name cannot exceed 100 characters');
    }

    // Job role validation
    if (!jobRole || jobRole.trim().length === 0) {
        errors.push('Job role is required');
    } else if (jobRole.length > 50) {
        errors.push('Job role cannot exceed 50 characters');
    }

    // City validation
    if (!city || city.trim().length === 0) {
        errors.push('City is required');
    } else if (city.length > 100) {
        errors.push('City cannot exceed 100 characters');
    }

    // Area validation
    if (!area || area.trim().length === 0) {
        errors.push('Area is required');
    } else if (area.length > 100) {
        errors.push('Area cannot exceed 100 characters');
    }

    // Phone number validation
    if (!phoneNumber || phoneNumber.trim().length === 0) {
        errors.push('Phone number is required');
    } else if (!/^\+?[\d\s\-\(\)]{10,15}$/.test(phoneNumber)) {
        errors.push('Please provide a valid phone number');
    }

    // Profile summary validation
    if (req.body.profileSummary && req.body.profileSummary.length > 500) {
        errors.push('Profile summary cannot exceed 500 characters');
    }

    // Education validation
    if (req.body.education) {
        if (!Array.isArray(req.body.education)) {
            errors.push('Education must be an array');
        } else {
            req.body.education.forEach((edu, index) => {
                if (!edu || typeof edu !== 'object') {
                    errors.push(`Education[${index}] must be a valid object`);
                    return;
                }
                if (!edu.universityName) {
                    errors.push(`Education[${index}]: universityName is required`);
                }
                if (!edu.speciality) {
                    errors.push(`Education[${index}]: speciality is required`);
                }
                if (!edu.startYear || !edu.endYear) {
                    errors.push(`Education[${index}]: startYear and endYear are required`);
                }
                if (edu.startYear > edu.endYear) {
                    errors.push(`Education[${index}]: startYear cannot be greater than endYear`);
                }
            });
        }
    }

    // Skills validation
    if (req.body.skills && !Array.isArray(req.body.skills)) {
        errors.push('Skills must be an array');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};


const validateHospitalProfile = (req, res, next) => {
    // Debug logging
    console.log('Request body:', req.body);
    console.log('Received fields:', Object.keys(req.body));
    
    const { hospitalLegalName, currentAddress, servicesAvailable, city, state, pincode, staffCount, phoneNumber, email } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['hospitalLegalName', 'currentAddress', 'servicesAvailable', 'city', 'state', 'pincode', 'staffCount', 'phoneNumber', 'email'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    console.log('Destructured hospitalLegalName:', hospitalLegalName);
    console.log('Type of hospitalLegalName:', typeof hospitalLegalName);

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    // Hospital legal name validation
    if (!hospitalLegalName || hospitalLegalName.trim().length === 0) {
        errors.push('Hospital legal name is required');
    } else if (hospitalLegalName.length > 200) {
        errors.push('Hospital legal name cannot exceed 200 characters');
    }

    // Email validation (basic format only)
    if (!email || !validator.isEmail(email)) {
        errors.push('Valid email is required');
    }

    // Current address validation
    if (!currentAddress || currentAddress.trim().length === 0) {
        errors.push('Current address is required');
    } else if (currentAddress.length > 300) {
        errors.push('Current address cannot exceed 300 characters');
    }

    // City validation
    if (!city || city.trim().length === 0) {
        errors.push('City is required');
    } else if (city.length > 100) {
        errors.push('City cannot exceed 100 characters');
    }

    // State validation
    if (!state || state.trim().length === 0) {
        errors.push('State is required');
    } else if (!INDIAN_STATES.includes(state)) {
        errors.push(`Invalid state. Must be one of: ${INDIAN_STATES.join(', ')}`);
    }

    // Pincode validation
    if (!pincode || pincode.trim().length === 0) {
        errors.push('Pincode is required');
    } else if (!/^[1-9][0-9]{5}$/.test(pincode)) {
        errors.push('Pincode must be a valid 6-digit Indian postal code');
    }

    // Services available validation
    if (!servicesAvailable || !Array.isArray(servicesAvailable) || servicesAvailable.length === 0) {
        errors.push('At least one service must be selected');
    } else {
        const validServices = [
            'Emergency Care', 'General Surgery', 'Cardiology', 'Neurology', 'Orthopedics',
            'Pediatrics', 'Obstetrics & Gynecology', 'Internal Medicine', 'Radiology',
            'Laboratory Services', 'Pharmacy', 'Physical Therapy', 'Mental Health',
            'Oncology', 'Dermatology', 'Ophthalmology', 'ENT (Ear, Nose, Throat)',
            'Urology', 'Gastroenterology', 'Pulmonology'
        ];

        const invalidServices = servicesAvailable.filter(service => !validServices.includes(service));
        if (invalidServices.length > 0) {
            errors.push(`Invalid services: ${invalidServices.join(', ')}`);
        }
    }

    // Total staff count validation
    const validStaffCounts = ['2-10', '11-50', '51-100', '100+'];
    if (!staffCount || !validStaffCounts.includes(staffCount)) {
        errors.push('Total staff count must be one of: 2-10, 11-50, 51-100, 100+');
    }

    // Phone number validation
    if (!phoneNumber || !/^(\+91) [6-9]\d{9}$/.test(phoneNumber)) {
        errors.push('Phone number must start with +91 followed by 10 digits');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};



const validateDutyStatusHistory = (req, res, next) => {
    const { dutyId } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['dutyId'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed field: dutyId`);
    }

    // Duty ID validation
    if (!dutyId) {
        errors.push('dutyId is required');
    } else if (!/^[0-9a-fA-F]{24}$/.test(dutyId)) {
        errors.push('Invalid dutyId format');
    }

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: errors.join(', ')
        });
    }

    next();
};


const validateDocumentUpload = (req, res, next) => {
    const files = req.files;
    const errors = [];

    // Allowed document types
    const allowedDocumentTypes = [
        "aadhaar-card",
        "pan-card",
        "degree-certificate",
        "mcim-certificate",
        "ncim-certificate",
        "license-permit",
        "resume-experience",
        "recommendation-letter",
        "cin-certificate",
        "gst-certificate",
        "nabh-certificate",
        "rohini-certificate",
        "cghs-certificate",
        "live-picture",
        "registration-certificate",
        "Other"
    ];

    // File type rules per document type
    const fileTypeRules = {
        "live-picture": {
            allowed: ["image/jpeg", "image/png"],
            message: "Live picture must be JPG or PNG image"
        },
        "resume-experience": {
            allowed: ["application/pdf"],
            message: "Resume must be PDF format"
        },
        // Default rule for certificates and ID documents
        "default": {
            allowed: ["application/pdf", "image/jpeg", "image/png"],
            message: "Document must be PDF, JPG, or PNG"
        }
    };

    if (!files || files.length === 0) {
        errors.push('No files uploaded');
    } else {
        // Validate each file's fieldname (documentType) and mimetype
        files.forEach((file, index) => {
            const documentType = file.fieldname;

            if (!documentType) {
                errors.push(`File at index ${index}: fieldname (documentType) is required`);
            } else if (!allowedDocumentTypes.includes(documentType)) {
                errors.push(`File at index ${index}: Invalid documentType "${documentType}". Allowed types: ${allowedDocumentTypes.join(', ')}`);
            } else {
                // Validate file type based on document type
                const rule = fileTypeRules[documentType] || fileTypeRules["default"];

                if (!rule.allowed.includes(file.mimetype)) {
                    errors.push(`File at index ${index} (${documentType}): ${rule.message}. Received: ${file.mimetype}`);
                }
            }
        });
    }

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Document upload validation failed',
            errors: errors
        });
    }

    next();
};



const validateProfileUpdate = (req, res, next) => {
    const errors = [];
    const { role } = req.user;
    
    // Dynamic validation based on user role
    if (role === 'staff') {
        const { fullName, jobRole, city, area, phoneNumber, coordinates } = req.body;
        
        // Validate staff-specific fields
        if (fullName && fullName.length > 100) {
            errors.push('Full name cannot exceed 100 characters');
        }
        
        if (city && city.length > 100) {
            errors.push('City cannot exceed 100 characters');
        }
        
        if (coordinates) {
            if (typeof coordinates.latitude !== 'number' || Math.abs(coordinates.latitude) > 90) {
                errors.push('Invalid latitude value');
            }
            if (typeof coordinates.longitude !== 'number' || Math.abs(coordinates.longitude) > 180) {
                errors.push('Invalid longitude value');
            }
        }
        
    } else if (role === 'hospital') {
        const { hospitalLegalName, currentAddress, servicesAvailable, city, state, pincode, staffCount, phoneNumber, email } = req.body;
        
        // Prevent email and phone number changes
        if (email && email !== req.user.email) {
            errors.push('Email cannot be changed after profile creation');
        }
        
        if (phoneNumber) {
            errors.push('Phone number cannot be changed after profile creation');
        }
        
        // Validate hospital-specific fields
        if (hospitalLegalName && hospitalLegalName.length > 200) {
            errors.push('Hospital name cannot exceed 200 characters');
        }
        
        // City validation
        if (city && city.length > 100) {
            errors.push('City cannot exceed 100 characters');
        }
        
        // State validation
        if (state) {
            if (!INDIAN_STATES.includes(state)) {
                errors.push('Invalid state. Must be a valid Indian state');
            }
        }
        
        // Pincode validation
        if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) {
            errors.push('Pincode must be a valid 6-digit Indian postal code');
        }

        // services validation
        if (servicesAvailable && (!Array.isArray(servicesAvailable) || servicesAvailable.length === 0)) {
            errors.push('At least one service must be selected');
        }
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for staff availability toggle
const validateStaffAvailability = (req, res, next) => {
    const { isAvailable } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['isAvailable'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    // isAvailable validation
    if (typeof isAvailable !== 'boolean') {
        errors.push('isAvailable must be a boolean value (true or false)');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};




// Validation for nearby staff search
const validateNearbyStaff = (req, res, next) => {
    const { radius } = req.query;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['radius'];
    const receivedFields = Object.keys(req.query);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    // Radius validation (optional)
    if (radius !== undefined) {
        const radiusNum = parseFloat(radius);
        if (isNaN(radiusNum) || radiusNum < 1 || radiusNum > 100) {
            errors.push('Radius must be a number between 1 and 100 kilometers');
        }
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};


// Validation for duty creation to prevent past/invalid times
const validateDutyCreation = (req, res, next) => {
    const { date, start_time, urgency } = req.body;
    const errors = [];
    
    if (date && start_time) {
        const now = getCurrentIST();
        const dutyDate = new Date(date);
        const [startHours, startMinutes] = start_time.split(':');
        
        // Validate time format
        if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(start_time)) {
            errors.push('Start time must be in HH:MM format');
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors
            });
        }
        
        // Convert duty date to IST and set time
        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);

        // Rule: Emergency duties can only be created if start time is within 1 hour
        if (urgency === 'emergency') {
            const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
            if (dutyStartTime > oneHourFromNow) {
                errors.push('Emergency duties can only be created for shifts starting within the next 1 hour. Please use a different urgency level for duties starting later.');
            }
        }
        
        // Add 15 minute buffer to account for creation and assignment time
        const bufferTime = new Date(dutyStartTime.getTime() - 15 * 60 * 1000);
        
        if (bufferTime <= now) {
            errors.push('Duty start time must be at least 15 minutes in the future. Cannot create duties for past or immediate times.');
        }
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
               });
    }
    
    next();
};



// Validation for duty acceptance
const validateDutyAcceptance = (req, res, next) => {
    const { duty_id } = req.body;
    const errors = [];
    
    // Check for unexpected fields
    const allowedFields = ['duty_id'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed: duty_id`);
    }
    
    if (!duty_id) {
        errors.push('duty_id is required');
    } else if (!/^[0-9a-fA-F]{24}$/.test(duty_id)) {
        errors.push('Invalid duty_id format');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for duty status change
const validateDutyStatusChange = (req, res, next) => {
    const { status, duty_id } = req.body;
    const errors = [];
    
    // Check for unexpected fields
    const allowedFields = ['status', 'duty_id'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }
    
    const allowedStatuses = ['enroute', 'in-progress', 'completed'];
    if (!status || !allowedStatuses.includes(status)) {
        errors.push(`Invalid status. Allowed: ${allowedStatuses.join(', ')}`);
    }
    
    if (!duty_id || !/^[0-9a-fA-F]{24}$/.test(duty_id)) {
        errors.push('Valid duty_id is required');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for duty cancellation
const validateDutyCancellation = (req, res, next) => {
    const { reason, reasonText } = req.body;
    const errors = [];
    
    // Check for unexpected fields
    const allowedFields = ['reason', 'reasonText'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }
    
    const validReasons = ['no_longer_needed', 'found_alternative', 'emergency_resolved', 'budget_constraints', 'other'];
    if (!reason || !validReasons.includes(reason)) {
        errors.push(`Valid reason is required. Allowed: ${validReasons.join(', ')}`);
    }
    
    if (reason === 'other' && (!reasonText || reasonText.trim().length === 0)) {
        errors.push('reasonText is required when reason is "other"');
    }
    
    if (reasonText && reasonText.length > 500) {
        errors.push('reasonText cannot exceed 500 characters');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for duty edit
const validateDutyEdit = (req, res, next) => {
    const errors = [];
    const allowedFields = [
        'staff_role', 'date', 'end_date', 'start_time', 'end_time',
        'urgency', 'description', 'offered_rate', 'is_overnight_duty'
    ];
    
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Allowed: ${allowedFields.join(', ')}`);
    }
    
    // Validate urgency if provided
    if (req.body.urgency && !['low', 'medium', 'high', 'critical'].includes(req.body.urgency)) {
        errors.push('Invalid urgency level');
    }
    
    // Validate offered_rate if provided
    if (req.body.offered_rate !== undefined) {
        const rate = parseFloat(req.body.offered_rate);
        if (isNaN(rate) || rate < 0 || rate > 50000) {
            errors.push('offered_rate must be a positive number less than 50000');
        }
    }
    
    // Validate time format if provided
    if (req.body.start_time && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(req.body.start_time)) {
        errors.push('start_time must be in HH:MM format');
    }
    
    if (req.body.end_time && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(req.body.end_time)) {
        errors.push('end_time must be in HH:MM format');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for pagination parameters
const validatePagination = (req, res, next) => {
    const errors = [];
    const { page, limit } = req.query;
    
    if (page !== undefined) {
        const pageNum = parseInt(page);
        if (isNaN(pageNum) || pageNum < 1 || pageNum > 1000) {
            errors.push('Page must be a number between 1 and 1000');
        }
    }
    
    if (limit !== undefined) {
        const limitNum = parseInt(limit);
        if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
            errors.push('Limit must be a number between 1 and 100');
        }
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for review submission
const validateReviewSubmission = (req, res, next) => {
    const { rating, comment, staffId } = req.body;
    const errors = [];
    
    // Check for unexpected fields
    const allowedFields = ['rating', 'comment', 'staffId'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }
    
    // Rating validation
    if (rating === undefined || typeof rating !== 'number' || rating < 1 || rating > 5) {
        errors.push('Rating must be a number between 1 and 5');
    }
    
    // Comment validation
    if (comment && (typeof comment !== 'string' || comment.length > 1000)) {
        errors.push('Comment must be a string with maximum 1000 characters');
    }
    
    // Staff ID validation
    if (!staffId || !/^[0-9a-fA-F]{24}$/.test(staffId)) {
        errors.push('Valid staffId is required');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for staff ID parameter
const validateStaffIdParam = (req, res, next) => {
    const { staffId } = req.params;
    const errors = [];
    
    if (!staffId || !/^[0-9a-fA-F]{24}$/.test(staffId)) {
        errors.push('Valid staffId parameter is required');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for notification ID
const validateNotificationId = (req, res, next) => {
    const { id } = req.params;
    const errors = [];
    
    if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
        errors.push('Valid notification ID is required');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for bulk notification read
const validateBulkNotificationRead = (req, res, next) => {
    const { notificationIds } = req.body;
    const errors = [];
    
    // Check for unexpected fields
    const allowedFields = ['notificationIds'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }
    
    if (!notificationIds || !Array.isArray(notificationIds) || notificationIds.length === 0) {
        errors.push('notificationIds must be a non-empty array');
    } else {
        notificationIds.forEach((id, index) => {
            if (!/^[0-9a-fA-F]{24}$/.test(id)) {
                errors.push(`Invalid notificationId at index ${index}`);
            }
        });
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for MongoDB ObjectId in params
const validateObjectId = (paramName = 'id') => (req, res, next) => {
    const id = req.params[paramName] || req.params.id;
    const errors = [];
    
    if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
        errors.push(`Valid ${paramName} is required`);
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for statement query parameters
const validateStatementQuery = (req, res, next) => {
    const errors = [];
    const { dutyId, startDate, endDate } = req.query;
    
    // Check for unexpected fields
    const allowedFields = ['dutyId', 'startDate', 'endDate', 'page', 'limit'];
    const receivedFields = Object.keys(req.query);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }
    
    // Validate dutyId if provided
    if (dutyId && !/^[0-9a-fA-F]{24}$/.test(dutyId)) {
        errors.push('Invalid dutyId format');
    }
    
    // Validate date format if provided
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        errors.push('startDate must be in YYYY-MM-DD format');
    }
    
    if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        errors.push('endDate must be in YYYY-MM-DD format');
    }
    
    // Validate date range
    if (startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        if (start > end) {
            errors.push('startDate cannot be greater than endDate');
        }
    }
    
    // Validate pagination
    const { page, limit } = req.query;
    if (page !== undefined) {
        const pageNum = parseInt(page);
        if (isNaN(pageNum) || pageNum < 1 || pageNum > 1000) {
            errors.push('Page must be a number between 1 and 1000');
        }
    }
    
    if (limit !== undefined) {
        const limitNum = parseInt(limit);
        if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
            errors.push('Limit must be a number between 1 and 100');
        }
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for notification list query parameters
const validateNotificationQuery = (req, res, next) => {
    const errors = [];
    const { page, limit, status, type } = req.query;
    
    // Check for unexpected fields
    const allowedFields = ['page', 'limit', 'status', 'type'];
    const receivedFields = Object.keys(req.query);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }
    
    // Validate pagination
    if (page !== undefined) {
        const pageNum = parseInt(page);
        if (isNaN(pageNum) || pageNum < 1 || pageNum > 1000) {
            errors.push('Page must be a number between 1 and 1000');
        }
    }
    
    if (limit !== undefined) {
        const limitNum = parseInt(limit);
        if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
            errors.push('Limit must be a number between 1 and 100');
        }
    }
    
    // Validate status filter
    if (status && !['read', 'unread', 'all'].includes(status)) {
        errors.push('Status must be one of: read, unread, all');
    }
    
    // Validate type filter
    if (type && !['duty', 'system', 'review', 'payment', 'all'].includes(type)) {
        errors.push('Type must be one of: duty, system, review, payment, all');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Simple validation for unread count 
const validateUnreadCountQuery = (req, res, next) => {
    const errors = [];
    const { type } = req.query;
    
    // Check for unexpected fields
    const allowedFields = ['type'];
    const receivedFields = Object.keys(req.query);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }
    
    // Validate type filter
    if (type && !['duty', 'system', 'review', 'payment', 'all'].includes(type)) {
        errors.push('Type must be one of: duty, system, review, payment, all');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};




// Validation for document list query parameters
const validateDocumentQuery = (req, res, next) => {
    const errors = [];
    const { page, limit, status, type, verified } = req.query;
    
    // Check for unexpected fields
    const allowedFields = ['page', 'limit', 'status', 'type', 'verified'];
    const receivedFields = Object.keys(req.query);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }
    
    // Validate pagination
    if (page !== undefined) {
        const pageNum = parseInt(page);
        if (isNaN(pageNum) || pageNum < 1 || pageNum > 1000) {
            errors.push('Page must be a number between 1 and 1000');
        }
    }
    
    if (limit !== undefined) {
        const limitNum = parseInt(limit);
        if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
            errors.push('Limit must be a number between 1 and 100');
        }
    }
    
    // Validate status filter
    if (status && !['pending', 'verified', 'rejected', 'all'].includes(status)) {
        errors.push('Status must be one of: pending, verified, rejected, all');
    }
    
    // Validate type filter
    if (type) {
        const validTypes = [
            "aadhaar-card", "pan-card", "degree-certificate", "mcim-certificate",
            "ncim-certificate", "license-permit", "resume-experience", "recommendation-letter",
            "cin-certificate", "gst-certificate", "nabh-certificate", "rohini-certificate",
            "cghs-certificate", "live-picture", "registration-certificate", "Other"
        ];
        if (!validTypes.includes(type)) {
            errors.push(`Invalid document type. Valid types: ${validTypes.join(', ')}`);
        }
    }
    
    // Validate verified filter
    if (verified && !['true', 'false', 'all'].includes(verified)) {
        errors.push('Verified must be one of: true, false, all');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for required status query parameters
const validateRequiredStatusQuery = (req, res, next) => {
    const errors = [];
    const { userRole } = req.query;
    
    // Check for unexpected fields
    const allowedFields = ['userRole'];
    const receivedFields = Object.keys(req.query);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));
    
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }
    
    // Validate userRole filter
    if (userRole && !['staff', 'hospital', 'all'].includes(userRole)) {
        errors.push('User role must be one of: staff, hospital, all');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};



// Validation for document ID parameter
const validateDocumentIdParam = (req, res, next) => {
    const { documentId } = req.params;
    const errors = [];
    
    if (!documentId || !/^[0-9a-fA-F]{24}$/.test(documentId)) {
        errors.push('Valid documentId parameter is required');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }
    
    next();
};




// Validation for dashboard location permission
const validateDashboardLocationPermission = (req, res, next) => {
    const { permissionGranted, latitude, longitude } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['permissionGranted', 'latitude', 'longitude'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    // Permission granted validation
    if (permissionGranted === undefined || typeof permissionGranted !== 'boolean') {
        errors.push('permissionGranted must be a boolean (true or false)');
    }

    // If permission granted, validate coordinates
    if (permissionGranted === true) {
        if (!latitude || typeof latitude !== 'number') {
            errors.push('Latitude is required and must be a number when permission is granted');
        } else if (latitude < -90 || latitude > 90) {
            errors.push('Latitude must be between -90 and 90');
        }

        if (!longitude || typeof longitude !== 'number') {
            errors.push('Longitude is required and must be a number when permission is granted');
        } else if (longitude < -180 || longitude > 180) {
            errors.push('Longitude must be between -180 and 180');
        }
    }

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }

    next();
};



// Validation for dashboard location update
const validateDashboardLocationUpdate = (req, res, next) => {
    const { latitude, longitude } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['latitude', 'longitude'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed fields: ${allowedFields.join(', ')}`);
    }

    // Latitude validation
    if (!latitude || typeof latitude !== 'number') {
        errors.push('Latitude is required and must be a number');
    } else if (latitude < -90 || latitude > 90) {
        errors.push('Latitude must be between -90 and 90');
    }

    // Longitude validation
    if (!longitude || typeof longitude !== 'number') {
        errors.push('Longitude is required and must be a number');
    } else if (longitude < -180 || longitude > 180) {
        errors.push('Longitude must be between -180 and 180');
    }

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
    }

    next();
};




// Validate active duties query parameters for hospital
const validateHospitalActiveDutiesQuery = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use query parameters only.'
        });
    }

    // Validate allowed query parameters only
    const allowedParams = ['role', 'status', 'page', 'limit'];
    const receivedParams = Object.keys(req.query);

    // Check for unexpected parameters
    const unexpectedParams = receivedParams.filter(param => !allowedParams.includes(param));
    if (unexpectedParams.length > 0) {
        return res.status(400).json({
            success: false,
            message: `Invalid query parameters: ${unexpectedParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
        });
    }

    const { role, status, page = 1, limit = 10 } = req.query;

    // Validate role parameter 
    if (role && typeof role !== 'string') {
        return res.status(400).json({
            success: false,
            message: 'Role parameter must be a string'
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
        status: status || null,
        page: pageNum,
        limit: limitNum
    };

    next();
};




// Validate duty route map parameters for hospital
const validateHospitalDutyRouteMap = (req, res, next) => {
    // Check for request body content - GET requests should not have body
    if (req.body && Object.keys(req.body).length > 0) {
        return res.status(400).json({
            success: false,
            message: 'GET request should not contain request body. Use path parameters only.'
        });
    }

    const { dutyId } = req.params;

    // Validate dutyId format
    const mongoose = require('mongoose');
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




module.exports = {
    validateSignup,
    validateOTP,
    validateResendOTP,
    validateSignin,
    validateForgotPassword,
    validateResetPassword,
    validateMedicalStaffProfile,
    validateHospitalProfile,
    validateDutyStatusHistory,
    validateDocumentUpload,
    validateProfileUpdate,
    validateStaffAvailability,
    validateDutyCreation,
    validateNearbyStaff,
    validateDutyAcceptance,
    validateDutyStatusChange,
    validateDutyCancellation,
    validateDutyEdit,
    validatePagination,
    validateReviewSubmission,
    validateStaffIdParam,
    validateNotificationId,
    validateBulkNotificationRead,
    validateObjectId,
    validateStatementQuery,
    validateNotificationQuery,
    validateUnreadCountQuery,
    validateDocumentQuery,
    validateRequiredStatusQuery,
    validateDocumentIdParam,
    validateDashboardLocationPermission,
    validateDashboardLocationUpdate,
    validateHospitalActiveDutiesQuery,
    validateHospitalDutyRouteMap
};