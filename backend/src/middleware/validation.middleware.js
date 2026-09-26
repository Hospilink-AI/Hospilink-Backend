const validator = require('validator');
const { body, validationResult } = require('express-validator');
const { ValidationError } = require('./error.middleware');
const { getCurrentIST, toIST } = require('../utils/helpers');
const { INDIAN_STATES, ALLOWED_ROLES } = require('../utils/constants');
const { DOCX_MIME_TYPE } = require('./upload.middleware');
const {
    STATUSES: JOB_APPLICATION_STATUSES, REJECTION_REASONS, RECRUITER_CHANGE_REASONS,
    CANDIDATE_CHANGE_REASONS, WITHDRAW_REASONS, SLOT_DURATIONS, REASON_TEXT_MAX_LENGTH
} = require('../utils/jobApplication.constants');
const {
    CATEGORIES: TICKET_CATEGORIES, SUBJECT_TYPES: TICKET_SUBJECT_TYPES, PARTY_ROLES: TICKET_PARTY_ROLES,
    PRIORITIES: TICKET_PRIORITIES, RESOLUTION_OUTCOMES: TICKET_RESOLUTION_OUTCOMES,
    RESOLUTION_ACTIONS: TICKET_RESOLUTION_ACTIONS, DOMAINS: TICKET_DOMAINS
} = require('../utils/ticket.constants');
const mongoose = require('mongoose');


const RESUME_ALLOWED_MIME_TYPES = [
    'application/pdf',
    DOCX_MIME_TYPE,
    'image/jpeg',
    'image/jpg',
    'image/png'
];
const RESUME_FORMAT_ERROR_MESSAGE = 'Resume must be PDF, DOCX, JPG, JPEG, or PNG format';


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
    } else if (name.length > 100) {
        errors.push('Name cannot exceed 100 characters');
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

    // Role validation — 'admin' is intentionally excluded; admin accounts are created
    // directly in the database and cannot be self-registered via this endpoint.
    const validRoles = ['hospital', 'staff'];
    if (!role || !validRoles.includes(role)) {
        errors.push('Valid role is required. Allowed: hospital, staff');
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
    const { fullName, jobRole, currentAddress, city, state, pincode, phoneNumber, email, profileSummary, education, skills, experience } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = [
        'fullName',
        'jobRole', 
        'currentAddress',
        'city',
        'state',
        'pincode',
        'phoneNumber',
        'email',
        'profileSummary',
        'education',
        'skills',
        'experience'
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

    // Current address validation
    if (!currentAddress || currentAddress.trim().length === 0) {
        errors.push('Current address is required');
    } else if (currentAddress.length > 300) {
        errors.push('Current address cannot exceed 300 characters');
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

    // Email validation
    if (!email || !validator.isEmail(email)) {
        errors.push('Valid email is required');
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

    // Experience validation
    const validExperienceValues = ['0-1 year', '1-3 years', '3-5 years', '5-10 years', '10-15 years', '15-20 years', '20+ years'];
    if (!experience || !validExperienceValues.includes(experience)) {
        errors.push(`Experience is required and must be one of: ${validExperienceValues.join(', ')}`);
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};


const validateHospitalProfile = (req, res, next) => {
    // Debug logging removed — req.body contains PII (email, phone, hospital name)
    const { hospitalLegalName, currentAddress, servicesAvailable, city, state, pincode, staffCount, phoneNumber, email, description } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['hospitalLegalName', 'currentAddress', 'servicesAvailable', 'city', 'state', 'pincode', 'staffCount', 'phoneNumber', 'email', 'description'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

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

    // Description validation 
    if (description && description.length > 1000) {
        errors.push('Description cannot exceed 1000 characters');
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
            allowed: RESUME_ALLOWED_MIME_TYPES,
            message: RESUME_FORMAT_ERROR_MESSAGE
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



// Single-file resume upload for the resume-first "apply for a job" staging
// flow (profile.routes.js's POST /resume-stage) — separate from
// validateDocumentUpload above since this endpoint takes exactly one file
// with a fixed field name, not an arbitrary set of documentType-keyed files.
// Mirrors validateDocumentUpload's fileTypeRules['resume-experience'] rule.
const validateResumeStageUpload = (req, res, next) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: 'Resume file is required'
        });
    }

    if (!RESUME_ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
        return res.status(400).json({
            success: false,
            message: RESUME_FORMAT_ERROR_MESSAGE
        });
    }

    next();
};



const validateProfileUpdate = (req, res, next) => {
    const errors = [];
    const { role } = req.user;
    
    // Dynamic validation based on user role
    if (role === 'staff') {
        const { fullName, jobRole, currentAddress, city, state, pincode, coordinates, experience } = req.body;
        
        // Prevent email changes (read-only after creation)
        if (req.body.email && req.body.email !== req.user.email) {
            errors.push('Email cannot be changed after profile creation');
        }
        
        // Prevent phone number changes (read-only after creation)
        if (req.body.phoneNumber) {
            errors.push('Phone number cannot be changed after profile creation');
        }
        
        // Validate staff-specific fields
        if (fullName && fullName.length > 100) {
            errors.push('Full name cannot exceed 100 characters');
        }
        
        if (currentAddress && currentAddress.length > 300) {
            errors.push('Current address cannot exceed 300 characters');
        }
        
        if (city && city.length > 100) {
            errors.push('City cannot exceed 100 characters');
        }
        
        if (state && !INDIAN_STATES.includes(state)) {
            errors.push('Invalid state. Must be a valid Indian state');
        }
        
        if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) {
            errors.push('Pincode must be a valid 6-digit Indian postal code');
        }
        
        // Experience validation
        if (experience) {
            const validExperienceValues = ['0-1 year', '1-3 years', '3-5 years', '5-10 years', '10-15 years', '15-20 years', '20+ years'];
            if (!validExperienceValues.includes(experience)) {
                errors.push(`Experience must be one of: ${validExperienceValues.join(', ')}`);
            }
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
        const { hospitalLegalName, currentAddress, servicesAvailable, city, state, pincode, staffCount, phoneNumber, email, description } = req.body;
        
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

        // Description validation 
        if (description && description.length > 1000) {
            errors.push('Description cannot exceed 1000 characters');
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
    const { radius, role } = req.query;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['radius', 'role'];
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

    // Role validation (optional)
    if (role !== undefined && typeof role !== 'string') {
        errors.push('Role parameter must be a string');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};


// Validation for duty creation to prevent past/invalid times
const validateDutyCreation = (req, res, next) => {
    const { date, start_time, urgency, staff_count, staff_role, duty_sub_type } = req.body;
    const errors = [];
    
    // Validate staff_count if provided
    if (staff_count !== undefined) {
        const count = parseInt(staff_count);
        if (isNaN(count) || count < 1 || count > 50) {
            errors.push('staff_count must be a number between 1 and 50');
        }
    }

    // RMO sub-type: required when role is rmo, forbidden otherwise
    if (staff_role === 'rmo') {
        const validSubTypes = ['ward', 'icu', 'casualty'];
        if (!duty_sub_type || !validSubTypes.includes(duty_sub_type)) {
            errors.push('Sub-type is required for RMO duties');
        }
    }
    
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
    
    const allowedStatuses = ['enroute'];
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





// Validation for requesting a Start OTP (staff taps "Get OTP" within range of the hospital)
const validateRequestStartOtp = (req, res, next) => {
    const errors = [];

    const allowedFields = [];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
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



// Validation for verifying the Start OTP (geofence handshake)
const validateVerifyStartOtp = (req, res, next) => {
    const { otp } = req.body;
    const errors = [];

    const allowedFields = ['otp'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }

    if (!otp || !/^\d{6}$/.test(otp)) {
        errors.push('OTP must be exactly 6 digits');
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



// Validation for verifying the End OTP + payment attestation
const validateVerifyEndOtp = (req, res, next) => {
    const { otp, paymentMethod, isPaid } = req.body;
    const errors = [];

    const allowedFields = ['otp', 'paymentMethod', 'isPaid'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }

    if (!otp || !/^\d{6}$/.test(otp)) {
        errors.push('OTP must be exactly 6 digits');
    }

    const validPaymentMethods = ['cash', 'upi', 'bank', 'will_pay_later'];
    if (!paymentMethod || !validPaymentMethods.includes(paymentMethod)) {
        errors.push(`paymentMethod is required. Allowed: ${validPaymentMethods.join(', ')}`);
    }

    if (typeof isPaid !== 'boolean') {
        errors.push('isPaid must be a boolean');
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



// Validation for resending an OTP — 'start' (staff-only, sent to hospital's phone) or
// 'end' (staff sent to staff's phone)
const validateResendOtp = (req, res, next) => {
    const { otpType } = req.body;
    const errors = [];

    const allowedFields = ['otpType'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }

    const validOtpTypes = ['start', 'end'];
    if (!otpType || !validOtpTypes.includes(otpType)) {
        errors.push(`otpType is required. Allowed: ${validOtpTypes.join(', ')}`);
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
    if (req.body.urgency && !['low', 'medium', 'high', 'emergency'].includes(req.body.urgency)) {
        errors.push('Invalid urgency level. Must be one of: low, medium, high, emergency');
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

    // If a new start_time is provided with a date, validate it is at least 15 minutes in the future.
    // Both must be present — if only start_time is sent (no date), the service resolves it
    // against the existing duty's date and will enforce the same rule there.
    if (
        req.body.start_time &&
        /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(req.body.start_time) &&
        req.body.date
    ) {
        const refDate = new Date(req.body.date);
        const [startHours, startMinutes] = req.body.start_time.split(':');
        const istRefDate = toIST(refDate);
        const newStartTime = new Date(istRefDate);
        newStartTime.setHours(parseInt(startHours), parseInt(startMinutes), 0, 0);
        const bufferTime = new Date(newStartTime.getTime() - 15 * 60 * 1000);
        const now = getCurrentIST();
        if (bufferTime <= now) {
            errors.push('New start time must be at least 15 minutes in the future');
        }
    }

    // If setting overnight duty to true, end_date must also be provided
    if (req.body.is_overnight_duty === true && !req.body.end_date) {
        errors.push('end_date is required when is_overnight_duty is true');
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



// Validation for job vacancy creation (shared by hospital and admin-on-behalf-of-hospital flows)
const validateJobVacancyCreation = (req, res, next) => {
    const { title, specialty, experience, education, skills, location, salary, description } = req.body;
    const errors = [];

    if (!title || typeof title !== 'string' || !title.trim()) {
        errors.push('title is required');
    } else if (title.trim().length > 200) {
        errors.push('title cannot exceed 200 characters');
    }

    if (!specialty || typeof specialty !== 'string' || !specialty.trim()) {
        errors.push('specialty is required');
    } else if (!ALLOWED_ROLES.includes(specialty.trim())) {
        errors.push(`specialty must be one of: ${ALLOWED_ROLES.join(', ')}`);
    }

    if (!description || typeof description !== 'string' || !description.trim()) {
        errors.push('description is required');
    } else if (description.trim().length > 3000) {
        errors.push('description cannot exceed 3000 characters');
    }

    if (experience !== undefined && typeof experience !== 'string') {
        errors.push('experience must be a string');
    }

    if (education !== undefined && typeof education !== 'string') {
        errors.push('education must be a string');
    }

    if (skills !== undefined && (!Array.isArray(skills) || !skills.every(s => typeof s === 'string'))) {
        errors.push('skills must be an array of strings');
    }

    if (location !== undefined && typeof location !== 'string') {
        errors.push('location must be a string');
    }

    if (salary !== undefined && typeof salary !== 'string') {
        errors.push('salary must be a string');
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



// Validation for job vacancy edits — partial patch over an allowed field whitelist
const validateJobVacancyEdit = (req, res, next) => {
    const errors = [];
    const allowedFields = ['title', 'specialty', 'experience', 'education', 'skills', 'location', 'salary', 'description'];

    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Allowed: ${allowedFields.join(', ')}`);
    }

    if (receivedFields.length === 0) {
        errors.push('At least one field must be provided to update');
    }

    if (req.body.title !== undefined && (typeof req.body.title !== 'string' || !req.body.title.trim())) {
        errors.push('title must be a non-empty string');
    }

    if (req.body.specialty !== undefined && (typeof req.body.specialty !== 'string' || !ALLOWED_ROLES.includes(req.body.specialty.trim()))) {
        errors.push(`specialty must be one of: ${ALLOWED_ROLES.join(', ')}`);
    }

    if (req.body.description !== undefined && (typeof req.body.description !== 'string' || !req.body.description.trim())) {
        errors.push('description must be a non-empty string');
    }

    if (req.body.skills !== undefined && (!Array.isArray(req.body.skills) || !req.body.skills.every(s => typeof s === 'string'))) {
        errors.push('skills must be an array of strings');
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



// ─── Job application — apply / review pipeline ──────────────────────────────

// Generic reviewer transitions only (applied->under_review->shortlisted->rejected,
// plus offered->rejected). Whether THIS specific transition is legal from the
// application's CURRENT status is checked in jobApplication.service.js via
// canTransitionGeneric — this only validates shape.
const validateJobApplicationStatusUpdate = (req, res, next) => {
    const { status, reason, reasonText } = req.body;
    const errors = [];

    const allowedFields = ['status', 'reason', 'reasonText'];
    const unexpectedFields = Object.keys(req.body).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed: ${allowedFields.join(', ')}`);
    }

    const allowedStatuses = ['under_review', 'shortlisted', 'rejected'];
    if (!status || !allowedStatuses.includes(status)) {
        errors.push(`status is required and must be one of: ${allowedStatuses.join(', ')}`);
    }

    if (status === 'rejected' && (!reason || !REJECTION_REASONS.includes(reason))) {
        errors.push(`reason is required when rejecting and must be one of: ${REJECTION_REASONS.join(', ')}`);
    }

    if (reasonText !== undefined && (typeof reasonText !== 'string' || reasonText.length > REASON_TEXT_MAX_LENGTH)) {
        errors.push(`reasonText must be a string under ${REASON_TEXT_MAX_LENGTH} characters`);
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    next();
};

const validateJobApplicationWithdraw = (req, res, next) => {
    const { reason, reasonText } = req.body;
    const errors = [];

    const allowedFields = ['reason', 'reasonText'];
    const unexpectedFields = Object.keys(req.body).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed: ${allowedFields.join(', ')}`);
    }

    if (!reason || !WITHDRAW_REASONS.includes(reason)) {
        errors.push(`reason is required and must be one of: ${WITHDRAW_REASONS.join(', ')}`);
    }

    if (reasonText !== undefined && (typeof reasonText !== 'string' || reasonText.length > REASON_TEXT_MAX_LENGTH)) {
        errors.push(`reasonText must be a string under ${REASON_TEXT_MAX_LENGTH} characters`);
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    next();
};

const validateJobApplicationListQuery = (req, res, next) => {
    const { status } = req.query;
    if (status && !JOB_APPLICATION_STATUSES.includes(status)) {
        return res.status(400).json({
            success: false,
            message: `status must be one of: ${JOB_APPLICATION_STATUSES.join(', ')}`
        });
    }
    next();
};

// ─── Job application — interview scheduling ─────────────────────────────────

const validateInterviewOfferSlots = (req, res, next) => {
    const { slots, durationMinutes } = req.body;
    const errors = [];

    const allowedFields = ['slots', 'durationMinutes'];
    const unexpectedFields = Object.keys(req.body).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed: ${allowedFields.join(', ')}`);
    }

    if (durationMinutes !== undefined && !SLOT_DURATIONS.includes(durationMinutes)) {
        errors.push(`durationMinutes must be one of: ${SLOT_DURATIONS.join(', ')}`);
    }

    if (!Array.isArray(slots) || slots.length === 0) {
        errors.push('slots is required and must be a non-empty array of { start, end }');
    } else {
        slots.forEach((slot, i) => {
            if (!slot || !slot.start || !slot.end || isNaN(Date.parse(slot.start)) || isNaN(Date.parse(slot.end))) {
                errors.push(`slots[${i}] must have valid ISO start and end dates`);
            }
        });
    }
    // Count/boundary/window rules (3-8 slots, 15-min boundaries, 24h-21d
    // window) are enforced in interviewScheduling.service.js#offerSlots
    // against the live, admin-editable SystemConfig values — not duplicated
    // here against a value that could drift out of sync.

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    next();
};

const validateInterviewSlotSelect = (req, res, next) => {
    const { picks } = req.body;
    const errors = [];

    if (!Array.isArray(picks) || picks.length === 0) {
        errors.push('picks is required and must be a non-empty array of { start, end }');
    } else {
        picks.forEach((slot, i) => {
            if (!slot || !slot.start || !slot.end || isNaN(Date.parse(slot.start)) || isNaN(Date.parse(slot.end))) {
                errors.push(`picks[${i}] must have valid ISO start and end dates`);
            }
        });
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    next();
};

const validateInterviewConfirm = (req, res, next) => {
    const { slotStart, slotEnd, meetingLink, interviewerName, interviewerDesignation } = req.body;
    const errors = [];

    if (!slotStart || isNaN(Date.parse(slotStart))) errors.push('slotStart is required and must be a valid ISO date');
    if (!slotEnd || isNaN(Date.parse(slotEnd))) errors.push('slotEnd is required and must be a valid ISO date');

    if (!meetingLink || typeof meetingLink !== 'string' || !/^https:\/\/.+/.test(meetingLink.trim())) {
        errors.push('meetingLink is required and must be a well-formed https:// URL');
    }
    if (!interviewerName || typeof interviewerName !== 'string' || !interviewerName.trim()) {
        errors.push('interviewerName is required');
    }
    if (!interviewerDesignation || typeof interviewerDesignation !== 'string' || !interviewerDesignation.trim()) {
        errors.push('interviewerDesignation is required');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    next();
};

const validateInterviewMeetingLink = (req, res, next) => {
    const { meetingLink, interviewerName, interviewerDesignation } = req.body;
    const errors = [];

    if (!meetingLink || typeof meetingLink !== 'string' || !/^https:\/\/.+/.test(meetingLink.trim())) {
        errors.push('meetingLink is required and must be a well-formed https:// URL');
    }
    if (interviewerName !== undefined && (typeof interviewerName !== 'string' || !interviewerName.trim())) {
        errors.push('interviewerName must be a non-empty string');
    }
    if (interviewerDesignation !== undefined && (typeof interviewerDesignation !== 'string' || !interviewerDesignation.trim())) {
        errors.push('interviewerDesignation must be a non-empty string');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    next();
};

// Shared by cancel-offer, reschedule (recruiter reasons), cancel-interview and
// reschedule-request (candidate reasons) — which list applies depends on
// req.user.role, checked here since both routes share this one validator.
const validateInterviewChangeReason = (req, res, next) => {
    const { reason, reasonText } = req.body;
    const errors = [];

    const allowedReasons = req.user?.role === 'hospital' ? RECRUITER_CHANGE_REASONS : CANDIDATE_CHANGE_REASONS;
    if (!reason || !allowedReasons.includes(reason)) {
        errors.push(`reason is required and must be one of: ${allowedReasons.join(', ')}`);
    }
    if (reasonText !== undefined && (typeof reasonText !== 'string' || reasonText.length > REASON_TEXT_MAX_LENGTH)) {
        errors.push(`reasonText must be a string under ${REASON_TEXT_MAX_LENGTH} characters`);
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    next();
};

const validateInterviewReschedule = (req, res, next) => {
    // Same slot-array shape as offer-slots, plus the same reason requirement
    // as a cancel — reschedule is both actions in one call.
    validateInterviewOfferSlots(req, res, (err) => {
        if (err) return next(err);
        validateInterviewChangeReason(req, res, next);
    });
};

const validateInterviewOutcome = (req, res, next) => {
    const { result, reason, reasonText } = req.body;
    const errors = [];

    const allowedResults = ['offer', 'reject'];
    if (!result || !allowedResults.includes(result)) {
        errors.push(`result is required and must be one of: ${allowedResults.join(', ')}`);
    }
    if (result === 'reject' && (!reason || !REJECTION_REASONS.includes(reason))) {
        errors.push(`reason is required when result is reject and must be one of: ${REJECTION_REASONS.join(', ')}`);
    }
    if (reasonText !== undefined && (typeof reasonText !== 'string' || reasonText.length > REASON_TEXT_MAX_LENGTH)) {
        errors.push(`reasonText must be a string under ${REASON_TEXT_MAX_LENGTH} characters`);
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    next();
};

const validateNoShowMark = (req, res, next) => {
    const { reoffer, newSlots, durationMinutes } = req.body;
    const errors = [];

    if (typeof reoffer !== 'boolean') {
        errors.push('reoffer is required and must be a boolean');
    }
    if (reoffer === true) {
        if (!Array.isArray(newSlots) || newSlots.length === 0) {
            errors.push('newSlots is required when reoffer is true, and must be a non-empty array of { start, end }');
        }
        if (durationMinutes !== undefined && !SLOT_DURATIONS.includes(durationMinutes)) {
            errors.push(`durationMinutes must be one of: ${SLOT_DURATIONS.join(', ')}`);
        }
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    next();
};

const validateOfferResponse = (req, res, next) => {
    const { accept } = req.body;
    if (typeof accept !== 'boolean') {
        return res.status(400).json({ success: false, message: 'accept is required and must be a boolean' });
    }
    next();
};

const validateInterviewConfigUpdate = (req, res, next) => {
    const { key, value, effectiveFrom } = req.body;
    const errors = [];

    if (!key || typeof key !== 'string' || !key.trim()) {
        errors.push('key is required');
    }
    if (value === undefined) {
        errors.push('value is required');
    }
    if (effectiveFrom !== undefined && isNaN(Date.parse(effectiveFrom))) {
        errors.push('effectiveFrom must be a valid ISO date when provided');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
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



// Validation for review submission (hospital -> staff)
const validateReviewSubmission = (req, res, next) => {
    const { rating, review, duty_id } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['rating', 'review', 'duty_id'];
    const receivedFields = Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }

    // Rating validation
    if (rating === undefined || typeof rating !== 'number' || rating < 1 || rating > 5) {
        errors.push('Rating must be a number between 1 and 5');
    }

    // Review validation
    if (review && (typeof review !== 'string' || review.length > 1000)) {
        errors.push('Review must be a string with maximum 1000 characters');
    }

    // Duty ID validation
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




// Validation for dashboard location permission (permission flag only — coordinates come via WebSocket)
const validateDashboardLocationPermission = (req, res, next) => {
    const { permissionGranted } = req.body;
    const errors = [];

    const allowedFields = ['permissionGranted'];
    const unexpectedFields = Object.keys(req.body).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}. Only allowed: ${allowedFields.join(', ')}`);
    }

    if (permissionGranted === undefined || typeof permissionGranted !== 'boolean') {
        errors.push('permissionGranted must be a boolean (true or false)');
    }

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors
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


// Phone OTP validators (profile creation flow) 
const validateSendPhoneOTP = (req, res, next) => {
    const { phoneNumber } = req.body;
    const errors = [];

    const allowedFields = ['phoneNumber'];
    const unexpected = Object.keys(req.body).filter(f => !allowedFields.includes(f));
    if (unexpected.length > 0) {
        errors.push(`Unexpected fields: ${unexpected.join(', ')}`);
    }

    if (!phoneNumber || phoneNumber.trim().length === 0) {
        errors.push('Phone number is required');
    } else if (!/^\+91\s?[6-9]\d{9}$/.test(phoneNumber.trim())) {
        errors.push('Phone number must be a valid Indian mobile number starting with +91');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};




const validateVerifyPhoneOTP = (req, res, next) => {
    const { phoneNumber, otp } = req.body;
    const errors = [];

    const allowedFields = ['phoneNumber', 'otp'];
    const unexpected = Object.keys(req.body).filter(f => !allowedFields.includes(f));
    if (unexpected.length > 0) {
        errors.push(`Unexpected fields: ${unexpected.join(', ')}`);
    }

    if (!phoneNumber || phoneNumber.trim().length === 0) {
        errors.push('Phone number is required');
    } else if (!/^\+91\s?[6-9]\d{9}$/.test(phoneNumber.trim())) {
        errors.push('Phone number must be a valid Indian mobile number starting with +91');
    }

    if (!otp || !/^\d{6}$/.test(otp)) {
        errors.push('OTP must be exactly 6 digits');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};


// Validate ticket creation (POST /api/tickets — IN_APP_FORM path)
//
// Whether raisedAgainst is actually required is NOT decided here — that
// depends on the category's resolutionClass, which needs an async
// SystemConfig lookup (ticketCategoryConfig.service), and every other
// validator in this file is deliberately synchronous. That check stays on
// the Ticket schema's own conditional validator (spec §04: "enforced on
// save, not by convention"), which surfaces as a clean 400 either way via
// error.middleware's handleValidationErrorDB. This validator only checks
// shape.
const TICKET_FREE_TEXT_LIMIT = 1000; // spec §16: fixed, not admin-editable

const validateTicketCreation = (req, res, next) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({ success: false, message: 'Request body is required' });
    }

    const { category, subjectType, subjectId, raisedAgainst, text } = req.body;
    const errors = [];

    const allowedFields = ['category', 'subjectType', 'subjectId', 'raisedAgainst', 'text', 'evidence'];
    const unexpectedFields = Object.keys(req.body).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }

    if (!category || !TICKET_CATEGORIES.includes(category)) {
        errors.push(`category is required and must be one of the recognised categories`);
    }

    if (subjectType !== undefined && !TICKET_SUBJECT_TYPES.includes(subjectType)) {
        errors.push(`subjectType must be one of: ${TICKET_SUBJECT_TYPES.join(', ')}`);
    }

    const needsSubject = subjectType !== undefined && subjectType !== 'NONE';
    if (needsSubject && (!subjectId || !mongoose.Types.ObjectId.isValid(subjectId))) {
        errors.push('subjectId is required and must be a valid ID when subjectType is not NONE');
    }

    if (raisedAgainst !== undefined && raisedAgainst !== null) {
        if (typeof raisedAgainst !== 'object' || !raisedAgainst.userId || !raisedAgainst.role) {
            errors.push('raisedAgainst, when provided, must include userId and role');
        } else {
            if (!mongoose.Types.ObjectId.isValid(raisedAgainst.userId)) {
                errors.push('raisedAgainst.userId must be a valid ID');
            }
            if (!TICKET_PARTY_ROLES.includes(raisedAgainst.role)) {
                errors.push(`raisedAgainst.role must be one of: ${TICKET_PARTY_ROLES.join(', ')}`);
            }
        }
    }

    if (!text || typeof text !== 'string' || !text.trim()) {
        errors.push('text is required');
    } else if (text.length > TICKET_FREE_TEXT_LIMIT) {
        errors.push(`text cannot exceed ${TICKET_FREE_TEXT_LIMIT} characters`);
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    req.validatedBody = {
        category,
        subjectType: subjectType || 'NONE',
        subjectId: subjectId || null,
        raisedAgainst: raisedAgainst || null,
        text: text.trim()
    };

    next();
};


// Validate admin reassigning a ticket to another admin
const validateTicketReassign = (req, res, next) => {
    const { to, reason } = req.body;
    const errors = [];

    const allowedFields = ['to', 'reason'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    if (!to || !mongoose.Types.ObjectId.isValid(to)) {
        errors.push('to is required and must be a valid admin ID');
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        errors.push('reason is required');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = { to, reason: reason.trim() };
    next();
};

// Validate admin requesting more information from the raiser
const validateTicketRequestInfo = (req, res, next) => {
    const { message } = req.body;
    const errors = [];

    const allowedFields = ['message'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    if (!message || typeof message !== 'string' || !message.trim()) {
        errors.push('message is required');
    } else if (message.length > TICKET_FREE_TEXT_LIMIT) {
        errors.push(`message cannot exceed ${TICKET_FREE_TEXT_LIMIT} characters`);
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = { message: message.trim() };
    next();
};

// Validate a raiser/respondent sending a chat message (Day 3 live chat).
// Runs after multer, same ordering as validateMagicBytes on the sibling
// /:id/evidence route, so req.body.text is already populated. Files are
// optional here (text-only messages are fine) — files.length is checked
// in ticketChat.service#sendMessage, not here, since this validator has no
// visibility into req.files either way.
const validateTicketChatMessage = (req, res, next) => {
    const { text } = req.body;
    const errors = [];

    const allowedFields = ['text'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    if (text !== undefined && (typeof text !== 'string' || text.length > TICKET_FREE_TEXT_LIMIT)) {
        errors.push(`text must be a string of at most ${TICKET_FREE_TEXT_LIMIT} characters`);
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = { text: text && text.trim() ? text.trim() : undefined };
    next();
};

// Same as above, plus the admin must say which party's thread this goes to.
const validateAdminTicketChatMessage = (req, res, next) => {
    const { text, party } = req.body;
    const errors = [];

    const allowedFields = ['text', 'party'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    if (text !== undefined && (typeof text !== 'string' || text.length > TICKET_FREE_TEXT_LIMIT)) {
        errors.push(`text must be a string of at most ${TICKET_FREE_TEXT_LIMIT} characters`);
    }
    if (party !== undefined && !['raiser', 'respondent'].includes(party)) {
        errors.push('party must be either raiser or respondent');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = { text: text && text.trim() ? text.trim() : undefined, party };
    next();
};

// Validate a chatbot intake turn. Runs after multer (same ordering as the
// ticket-chat routes), so req.body.text/conversationId/selectedButton are
// already populated from the multipart form fields.
const CHATBOT_LANGUAGES = ['en', 'hi', 'mr'];

const validateChatbotMessage = (req, res, next) => {
    const { text, conversationId, selectedButton, language } = req.body;
    const errors = [];

    const allowedFields = ['text', 'conversationId', 'selectedButton', 'language'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    if (text !== undefined && (typeof text !== 'string' || text.length > TICKET_FREE_TEXT_LIMIT)) {
        errors.push(`text must be a string of at most ${TICKET_FREE_TEXT_LIMIT} characters`);
    }
    if (conversationId !== undefined && !mongoose.Types.ObjectId.isValid(conversationId)) {
        errors.push('conversationId must be a valid id');
    }
    if (selectedButton !== undefined && typeof selectedButton !== 'string') {
        errors.push('selectedButton must be a string');
    }
    // Only meaningful when starting a new conversation — ignored otherwise
    // (see chatbotIntake.service#sendMessage) — still type/enum-checked here.
    if (language !== undefined && !CHATBOT_LANGUAGES.includes(language)) {
        errors.push(`language must be one of: ${CHATBOT_LANGUAGES.join(', ')}`);
    }
    const hasFiles = req.files && req.files.length > 0;
    if (!text?.trim() && !selectedButton && !hasFiles) {
        errors.push('A message needs text, a selected button, or at least one file.');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = {
        text: text && text.trim() ? text.trim() : undefined,
        conversationId: conversationId || undefined,
        selectedButton: selectedButton || undefined,
        language: language || undefined
    };
    next();
};

// Validate an admin creating/updating a knowledge base article (chatbot
// intake Phase 4).
const KB_CATEGORIES = [...TICKET_DOMAINS, 'general'];
const validateKnowledgeBaseArticle = (req, res, next) => {
    const { question, answer, category, keywords } = req.body;
    const errors = [];

    const allowedFields = ['question', 'answer', 'category', 'keywords'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    if (question !== undefined && (typeof question !== 'string' || !question.trim() || question.length > 500)) {
        errors.push('question must be a non-empty string of at most 500 characters');
    }
    if (answer !== undefined && (typeof answer !== 'string' || !answer.trim() || answer.length > 2000)) {
        errors.push('answer must be a non-empty string of at most 2000 characters');
    }
    if (category !== undefined && !KB_CATEGORIES.includes(category)) {
        errors.push(`category must be one of: ${KB_CATEGORIES.join(', ')}`);
    }
    if (keywords !== undefined && (!Array.isArray(keywords) || !keywords.every(k => typeof k === 'string'))) {
        errors.push('keywords must be an array of strings');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = {
        question: question?.trim(),
        answer: answer?.trim(),
        category,
        keywords
    };
    next();
};

// Validate admin recategorising a ticket
const validateTicketRecategorize = (req, res, next) => {
    const { category, reason } = req.body;
    const errors = [];

    const allowedFields = ['category', 'reason'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    if (!category || !TICKET_CATEGORIES.includes(category)) {
        errors.push('category is required and must be one of the recognised categories');
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        errors.push('reason is required');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = { category, reason: reason.trim() };
    next();
};

// Validate admin overriding a ticket's computed priority
const validateTicketPriorityOverride = (req, res, next) => {
    const { value, reason } = req.body;
    const errors = [];

    const allowedFields = ['value', 'reason'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    if (!value || !TICKET_PRIORITIES.includes(value)) {
        errors.push(`value is required and must be one of: ${TICKET_PRIORITIES.join(', ')}`);
    }
    // Whether a reason is actually required depends on whether this raises
    // or lowers the ticket's current priority — that needs the ticket
    // itself, so the conditional check lives in ticket.service#priorityOverride.
    // Here we only type-check it when present.
    if (reason !== undefined && (typeof reason !== 'string' || !reason.trim())) {
        errors.push('reason must be a non-empty string when provided');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = { value, reason: reason ? reason.trim() : undefined };
    next();
};

// Validate a raiser withdrawing their own ticket
const validateTicketWithdraw = (req, res, next) => {
    const { reason } = req.body || {};
    const allowedFields = ['reason'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        return res.status(400).json({ success: false, message: `Unexpected fields: ${unexpectedFields.join(', ')}` });
    }
    if (reason !== undefined && typeof reason !== 'string') {
        return res.status(400).json({ success: false, message: 'reason must be a string' });
    }
    req.validatedBody = { reason: reason ? reason.trim() : null };
    next();
};


// Validate a respondent's answer to a claim
const validateTicketRespond = (req, res, next) => {
    const { text } = req.body || {};
    const allowedFields = ['text'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        return res.status(400).json({ success: false, message: `Unexpected fields: ${unexpectedFields.join(', ')}` });
    }
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ success: false, message: 'text is required' });
    }
    if (text.length > TICKET_FREE_TEXT_LIMIT) {
        return res.status(400).json({ success: false, message: `text cannot exceed ${TICKET_FREE_TEXT_LIMIT} characters` });
    }
    req.validatedBody = { text: text.trim() };
    next();
};


// Validate an admin's proposed decision on a ticket
const validateTicketDecision = (req, res, next) => {
    const { resolutionOutcome, resolutionActions, note, evidenceReliedOn } = req.body || {};
    const errors = [];

    const allowedFields = ['resolutionOutcome', 'resolutionActions', 'note', 'evidenceReliedOn'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    // Only rules out a garbage value — whether this outcome is legal for
    // THIS ticket's resolutionClass needs the ticket loaded, so that check
    // stays in ticket.service#decide (same async-dependency reason
    // validateTicketCreation defers raisedAgainst's conditional requirement).
    if (!resolutionOutcome || !TICKET_RESOLUTION_OUTCOMES.includes(resolutionOutcome)) {
        errors.push(`resolutionOutcome is required and must be one of: ${TICKET_RESOLUTION_OUTCOMES.join(', ')}`);
    }

    if (!Array.isArray(resolutionActions) || resolutionActions.length === 0) {
        errors.push('resolutionActions is required and must be a non-empty array');
    } else {
        resolutionActions.forEach((entry, i) => {
            if (!entry || typeof entry !== 'object' || !TICKET_RESOLUTION_ACTIONS.includes(entry.action)) {
                errors.push(`resolutionActions[${i}].action must be one of the recognised actions`);
            }
            if (entry && entry.details !== undefined && typeof entry.details !== 'object') {
                errors.push(`resolutionActions[${i}].details must be an object when provided`);
            }
        });
    }

    if (note !== undefined && typeof note !== 'string') {
        errors.push('note must be a string');
    }
    if (evidenceReliedOn !== undefined) {
        if (!Array.isArray(evidenceReliedOn) || evidenceReliedOn.some(id => !mongoose.Types.ObjectId.isValid(id))) {
            errors.push('evidenceReliedOn must be an array of valid IDs');
        }
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }

    req.validatedBody = {
        resolutionOutcome,
        resolutionActions: resolutionActions.map(a => ({ action: a.action, details: a.details || {} })),
        note: note || null,
        evidenceReliedOn: evidenceReliedOn || []
    };
    next();
};

// Validate a second admin returning a decision for review
const validateTicketReturnForReview = (req, res, next) => {
    const { reason } = req.body || {};
    const allowedFields = ['reason'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        return res.status(400).json({ success: false, message: `Unexpected fields: ${unexpectedFields.join(', ')}` });
    }
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        return res.status(400).json({ success: false, message: 'reason is required' });
    }
    req.validatedBody = { reason: reason.trim() };
    next();
};


// Validate a party appealing a decided ticket
const validateTicketAppeal = (req, res, next) => {
    const { reasonText } = req.body || {};
    const allowedFields = ['reasonText'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        return res.status(400).json({ success: false, message: `Unexpected fields: ${unexpectedFields.join(', ')}` });
    }
    if (!reasonText || typeof reasonText !== 'string' || !reasonText.trim()) {
        return res.status(400).json({ success: false, message: 'reasonText is required' });
    }
    if (reasonText.length > TICKET_FREE_TEXT_LIMIT) {
        return res.status(400).json({ success: false, message: `reasonText cannot exceed ${TICKET_FREE_TEXT_LIMIT} characters` });
    }
    req.validatedBody = { reasonText: reasonText.trim() };
    next();
};


// Validate an admin deciding a suspension proposal
const validateSuspensionDecision = (req, res, next) => {
    const { decision, decisionReason } = req.body || {};
    const errors = [];
    const allowedFields = ['decision', 'decisionReason'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    const allowed = ['suspend', 'no_action'];
    if (!decision || !allowed.includes(decision)) {
        errors.push(`decision is required and must be one of: ${allowed.join(', ')}`);
    }
    if (!decisionReason || typeof decisionReason !== 'string' || !decisionReason.trim()) {
        errors.push('decisionReason is required');
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = { decision, decisionReason: decisionReason.trim() };
    next();
};

// Validate a party responding to a suspension proposal
const validateSuspensionResponse = (req, res, next) => {
    const { text } = req.body || {};
    const allowedFields = ['text'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        return res.status(400).json({ success: false, message: `Unexpected fields: ${unexpectedFields.join(', ')}` });
    }
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ success: false, message: 'text is required' });
    }
    req.validatedBody = { text: text.trim() };
    next();
};


const FEEDBACK_AREAS = ['onboarding', 'duty_flow', 'otp', 'notifications', 'payments', 'jobs', 'app_performance', 'other'];
const FEEDBACK_SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'SEVERE_NEGATIVE'];

// Validate platform feedback submission
const validateFeedbackSubmission = (req, res, next) => {
    const { text, area } = req.body || {};
    const errors = [];
    const allowedFields = ['text', 'area'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);

    if (!text || typeof text !== 'string' || !text.trim()) {
        errors.push('text is required');
    } else if (text.length > TICKET_FREE_TEXT_LIMIT) {
        errors.push(`text cannot exceed ${TICKET_FREE_TEXT_LIMIT} characters`);
    }
    if (area !== undefined && !FEEDBACK_AREAS.includes(area)) {
        errors.push(`area must be one of: ${FEEDBACK_AREAS.join(', ')}`);
    }

    if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
    }
    req.validatedBody = { text: text.trim(), area: area || 'other' };
    next();
};

// Validate an admin overriding platform feedback's sentiment
const validateSentimentOverride = (req, res, next) => {
    const { sentiment } = req.body || {};
    const allowedFields = ['sentiment'];
    const unexpectedFields = Object.keys(req.body || {}).filter(f => !allowedFields.includes(f));
    if (unexpectedFields.length > 0) {
        return res.status(400).json({ success: false, message: `Unexpected fields: ${unexpectedFields.join(', ')}` });
    }
    if (!sentiment || !FEEDBACK_SENTIMENTS.includes(sentiment)) {
        return res.status(400).json({ success: false, message: `sentiment is required and must be one of: ${FEEDBACK_SENTIMENTS.join(', ')}` });
    }
    req.validatedBody = { sentiment };
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
    validateResumeStageUpload,
    validateProfileUpdate,
    validateStaffAvailability,
    validateDutyCreation,
    validateNearbyStaff,
    validateDutyAcceptance,
    validateDutyStatusChange,
    validateRequestStartOtp,
    validateVerifyStartOtp,
    validateVerifyEndOtp,
    validateResendOtp,
    validateDutyCancellation,
    validateDutyEdit,
    validateJobVacancyCreation,
    validateJobVacancyEdit,
    validatePagination,
    validateJobApplicationStatusUpdate,
    validateJobApplicationWithdraw,
    validateJobApplicationListQuery,
    validateInterviewOfferSlots,
    validateInterviewSlotSelect,
    validateInterviewConfirm,
    validateInterviewMeetingLink,
    validateInterviewChangeReason,
    validateInterviewReschedule,
    validateInterviewOutcome,
    validateNoShowMark,
    validateOfferResponse,
    validateInterviewConfigUpdate,
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
    validateHospitalDutyRouteMap,
    validateSendPhoneOTP,
    validateVerifyPhoneOTP,
    validateTicketCreation,
    validateTicketReassign,
    validateTicketRequestInfo,
    validateTicketChatMessage,
    validateAdminTicketChatMessage,
    validateChatbotMessage,
    validateKnowledgeBaseArticle,
    validateTicketRecategorize,
    validateTicketPriorityOverride,
    validateTicketWithdraw,
    validateTicketRespond,
    validateTicketDecision,
    validateTicketReturnForReview,
    validateTicketAppeal,
    validateSuspensionDecision,
    validateSuspensionResponse,
    validateFeedbackSubmission,
    validateSentimentOverride
};