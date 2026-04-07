const validator = require('validator');
const { body, validationResult } = require('express-validator');
const { ValidationError } = require('./error.middleware');
const { getCurrentIST, toIST } = require('../utils/helpers');

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
        throw new ValidationError(errors.join(', '));
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


const validateMedicalStaffProfile = (req, res, next) => {
    const { fullName, jobRole, city, area, phoneNumber, preCapturedLocation } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = [
        'fullName',
        'jobRole',
        'city',
        'area',
        'phoneNumber',
        'preCapturedLocation',
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
    const { hospitalLegalName, currentAddress, servicesAvailable, location, staffCount } = req.body;
    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['hospitalLegalName', 'currentAddress', 'servicesAvailable', 'location', 'staffCount'];
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

    // Current address validation
    if (!currentAddress || currentAddress.trim().length === 0) {
        errors.push('Current address is required');
    } else if (currentAddress.length > 300) {
        errors.push('Current address cannot exceed 300 characters');
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

    // Location validation
    if (!location || location.trim().length === 0) {
        errors.push('Location is required');
    } else if (location.length > 300) {
        errors.push('Location cannot exceed 300 characters');
    }

    // Staff count validation
    const validStaffCounts = ['2-10', '11-50', '51-100', '100+'];
    if (!staffCount || !validStaffCounts.includes(staffCount)) {
        errors.push('Staff count must be one of: 2-10, 11-50, 51-100, 100+');
    }

    if (errors.length > 0) {
        throw new ValidationError(errors.join(', '));
    }

    next();
};




const validateLocationPermission = (req, res, next) => {
    // Support both GET (query params) and POST (body) requests
    let locationPermission, currentLocation;

    if (req.method === 'GET') {
        // For GET requests - read from query parameters
        locationPermission = req.query.locationPermission || 'denied';
        currentLocation = req.query.currentLocation ? JSON.parse(req.query.currentLocation) : null;
    } else {
        // For POST requests - read from body
        locationPermission = req.body.locationPermission || 'denied';
        currentLocation = req.body.currentLocation || null;
    }

    const errors = [];

    // Check for unexpected fields
    const allowedFields = ['locationPermission', 'currentLocation'];
    const receivedFields = req.method === 'GET' ? Object.keys(req.query) : Object.keys(req.body);
    const unexpectedFields = receivedFields.filter(field => !allowedFields.includes(field));

    if (unexpectedFields.length > 0) {
        errors.push(`Unexpected fields: ${unexpectedFields.join(', ')}`);
    }

    if (!locationPermission || !['granted', 'denied'].includes(locationPermission)) {
        errors.push('Valid location permission (granted/denied) is required');
    }

    if (locationPermission === 'granted' && !currentLocation) {
        errors.push('Current location coordinates are required when permission is granted');
    }

    if (currentLocation) {
        if (!currentLocation.latitude || !currentLocation.longitude) {
            errors.push('Both latitude and longitude are required in currentLocation');
        }

        if (typeof currentLocation.latitude !== 'number' || typeof currentLocation.longitude !== 'number') {
            errors.push('Location coordinates must be numbers');
        }

        // Add coordinate range validation
        if (Math.abs(currentLocation.latitude) > 90) {
            errors.push('Latitude must be between -90 and 90');
        }

        if (Math.abs(currentLocation.longitude) > 180) {
            errors.push('Longitude must be between -180 and 180');
        }
    }

    // Attach parsed data to request for controllers
    req.locationPermission = locationPermission;
    req.currentLocation = currentLocation;

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: errors
        });
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
        const { hospitalLegalName, currentAddress, servicesAvailable, location } = req.body;
        
        // Validate hospital-specific fields
        if (hospitalLegalName && hospitalLegalName.length > 200) {
            errors.push('Hospital name cannot exceed 200 characters');
        }
        
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
const validateStaffAvailability = [
    body('isAvailable')
        .isBoolean()
        .withMessage('isAvailable must be a boolean value (true or false)')
        .custom(value => {
            if (typeof value !== 'boolean') {
                throw new Error('isAvailable must be a boolean value');
            }
            return true;
        }),
    
    // Custom validation result handler
    (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array().map(err => ({
                    field: err.path,
                    message: err.msg
                }))
            });
        }
        next();
    }
];



// Validation for duty creation to prevent past/invalid times
const validateDutyCreation = (req, res, next) => {
    const { date, start_time } = req.body;
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

module.exports = {
    validateSignup,
    validateOTP,
    validateResendOTP,
    validateSignin,
    validateMedicalStaffProfile,
    validateHospitalProfile,
    validateLocationPermission,
    validateDutyStatusHistory,
    validateDocumentUpload,
    validateProfileUpdate,
    validateStaffAvailability,
    validateDutyCreation  
};