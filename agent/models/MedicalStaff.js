const mongoose = require('mongoose');
const { INDIAN_STATES } = require('../utils/constants');

const medicalStaffSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'User reference is required'],
        unique: true
    },
    fullName: {
        type: String,
        required: [true, 'Full name is required'],
        trim: true,
        maxlength: [100, 'Full name cannot exceed 100 characters']
    },
    jobRole: {
        type: String,
        required: [true, 'Job role is required'],
        trim: true,
        maxlength: [50, 'Job role cannot exceed 50 characters']
    },
    city: {
        type: String,
        required: [true, 'City is required'],
        trim: true,
        maxlength: [100, 'City cannot exceed 100 characters']
    },
    currentAddress: {
        type: String,
        required: [true, 'Current address is required'],
        trim: true,
        maxlength: [300, 'Current address cannot exceed 300 characters']
    },
    state: {
        type: String,
        required: [true, 'State is required'],
        trim: true,
        enum: {
            values: INDIAN_STATES,
            message: 'State must be a valid Indian state'
        }
    },
    pincode: {
        type: String,
        required: [true, 'Pincode is required'],
        trim: true,
        validate: {
            validator: function(v) {
                return /^[1-9][0-9]{5}$/.test(v);
            },
            message: 'Pincode must be a valid 6-digit Indian postal code'
        }
    },
    email: {
        type: String,
        required: [true, 'Email is required'],
        trim: true,
        lowercase: true,
        validate: {
            validator: function(v) {
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
            },
            message: 'Please provide a valid email address'
        }
    },
    profilePicture: {
        s3Key: {
            type: String,
            default: null
        },
        uploadedAt: {
            type: Date
        },
        fileSize: {
            type: Number
        },
        mimeType: {
            type: String
        }
    },
    profileSummary: {
        type: String,
        trim: true,
        maxlength: [500, 'Profile summary cannot exceed 500 characters']
    },
    education: [
        {
            universityName: {
                type: String,
                trim: true,
                required: true
            },
            speciality: {
                type: String,
                trim: true,
                required: true
            },
            startYear: {
                type: Number,
                required: true,
                min: 1950,
                max: new Date().getFullYear()
            },
            endYear: {
                type: Number,
                required: true,
                min: 1950,
                max: new Date().getFullYear()
            }
        }
    ],
    skills: [
        {
            type: String,
            trim: true
        }
    ],
    coordinates: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            latitude: {
                type: Number,
                required: true
            },
            longitude: {
                type: Number,
                required: true
            }
        }
    },
    phoneNumber: {
        type: String,
        required: [true, 'Phone number is required'],
        trim: true,
        validate: {
            validator: function (v) {
                return /^\+?[\d\s\-\(\)]{10,15}$/.test(v);
            },
            message: 'Please provide a valid phone number'
        }
    },
    isProfileComplete: {
        type: Boolean,
        default: true
    },
    isDocumentsUploaded: {
        type: Boolean,
        default: false,
        index: true
    },
    isAvailable: {
        type: Boolean,
        default: false,
        index: true
    },
    averageRating: {
        type: Number,
        default: 0
    },
    totalRatings: {
        type: Number,
        default: 0
    },
    verificationStatus: {
        type: String,
        enum: ['pending', 'verified', 'rejected'],
        default: 'pending',
        index: true
    },
    rejectionReason: {
        type: String,
        trim: true,
        maxlength: [500, 'Rejection reason cannot exceed 500 characters']
    },
    experience: {
        type: String,
        enum: {
            values: ['0-1 year', '1-3 years', '3-5 years', '5-10 years', '10-15 years', '15-20 years', '20+ years'],
            message: 'Invalid experience value. Must be one of: 0-1 year, 1-3 years, 3-5 years, 5-10 years, 10-15 years, 15-20 years, 20+ years'
        },
        required: [true, 'Experience is required']
    }
}, {
    timestamps: true
});

medicalStaffSchema.index({ user: 1 });
medicalStaffSchema.index({ city: 1 });
medicalStaffSchema.index({ state: 1 });
medicalStaffSchema.index({ currentAddress: 1 });
medicalStaffSchema.index({ jobRole: 1 });
medicalStaffSchema.index({ 'coordinates.coordinates.longitude': 1 });
medicalStaffSchema.index({ 'coordinates.coordinates.latitude': 1 });
medicalStaffSchema.index({
    isAvailable: 1,
    jobRole: 1,
    'coordinates.coordinates.latitude': 1,
    'coordinates.coordinates.longitude': 1
});
medicalStaffSchema.index({
    user: 1,
    isAvailable: 1,
    updatedAt: -1
});
medicalStaffSchema.index({
    isAvailable: 1,
    updatedAt: -1
});
medicalStaffSchema.index({ user: 1, updatedAt: -1 });
medicalStaffSchema.virtual('coordinatesArray').get(function () {
    return [this.coordinates.coordinates.longitude, this.coordinates.coordinates.latitude];
});
medicalStaffSchema.index({ coordinatesArray: '2dsphere' });
medicalStaffSchema.index({ skills: 1 });
medicalStaffSchema.index({ 'education.speciality': 1 });
medicalStaffSchema.index({
    verificationStatus: 1,
    averageRating: -1
});
medicalStaffSchema.index({
    skills: 1,
    isAvailable: 1,
    'coordinates.coordinates.latitude': 1,
    'coordinates.coordinates.longitude': 1
});
medicalStaffSchema.index({ user: 1, verificationStatus: 1 });
medicalStaffSchema.index({ verificationStatus: 1, createdAt: -1 });
medicalStaffSchema.index({ verificationStatus: 1, rejectionReason: 1 });
medicalStaffSchema.index({ user: 1, verificationStatus: 1, rejectionReason: 1 });
medicalStaffSchema.index({
    isAvailable: 1,
    verificationStatus: 1,
    'coordinates.coordinates.latitude': 1,
    'coordinates.coordinates.longitude': 1,
    jobRole: 1
});
medicalStaffSchema.index({
    isAvailable: 1,
    'coordinates.coordinates.latitude': 1,
    'coordinates.coordinates.longitude': 1
});
medicalStaffSchema.index({
    user: 1,
    isAvailable: 1,
    updatedAt: -1
});

const MedicalStaff = mongoose.model('MedicalStaff', medicalStaffSchema);
module.exports = MedicalStaff;