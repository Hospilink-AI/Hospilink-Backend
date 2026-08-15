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
        trim: true,
        maxlength: [50, 'Job role cannot exceed 50 characters']
    },
    city: {
        type: String,
        trim: true,
        maxlength: [100, 'City cannot exceed 100 characters']
    },
    currentAddress: {
        type: String,
        trim: true,
        maxlength: [300, 'Current address cannot exceed 300 characters']
    },
    state: {
        type: String,
        trim: true,
        enum: {
            values: INDIAN_STATES,
            message: 'State must be a valid Indian state'
        }
    },
    pincode: {
        type: String,
        trim: true,
        validate: {
            validator: function(v) {
                return !v || /^[1-9][0-9]{5}$/.test(v);
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
            enum: ['Point']
        },
        coordinates: {
            latitude: {
                type: Number
            },
            longitude: {
                type: Number
            }
        }
    },
    phoneNumber: {
        type: String,
        trim: true,
        validate: {
            validator: function (v) {
                return !v || /^\+?[\d\s\-\(\)]{10,15}$/.test(v);
            },
            message: 'Please provide a valid phone number'
        }
    },
    normalizedPhone: {
        type: String,
        unique: true,
        sparse: true
    },
    isPhoneVerified: {
        type: Boolean,
        default: false
    },
    isProfileComplete: {
        type: Boolean,
        default: true
    },
    // Which onboarding path created this record — set once at creation, never
    // changed afterward. Purely a routing signal for checkProfileCompletion
    // (profile.service.js): 'resume_autofill' and 'resume_reviewed' profiles
    // both skip the KYC-document onboarding step entirely, since no
    // verification is required to apply for a permanent job. Unset on every
    // profile created before this field existed — treated the same as
    // 'manual' by that routing logic, so no backfill is needed.
    //
    // 'manual'          — full form, filled by hand (existing flow)
    // 'resume_reviewed' — resume-first "apply for a job" flow
    //                     parse result staged in Redis, shown in an editable
    //                     form, confirmed with phone-OTP like the manual path,
    //                     then written to MedicalStaff (profile.service.js's
    //                     stageResumeForProfile + createMedicalStaffProfile)
    profileSource: {
        type: String,
        enum: ['manual', 'resume_autofill', 'resume_reviewed']
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
    isSuspended: {
        type: Boolean,
        default: false,
        index: true
    },
    suspensionReason: {
        type: String,
        trim: true,
        maxlength: [500, 'Suspension reason cannot exceed 500 characters'],
        default: null
    },
    suspendedAt: {
        type: Date,
        default: null
    },
    // Not required — populated from a resume when the parser can confidently
    // bucket it; required for the manual flow via validateMedicalStaffProfile.
    experience: {
        type: String,
        enum: {
            values: ['0-1 year', '1-3 years', '3-5 years', '5-10 years', '10-15 years', '15-20 years', '20+ years'],
            message: 'Invalid experience value. Must be one of: 0-1 year, 1-3 years, 3-5 years, 5-10 years, 10-15 years, 15-20 years, 20+ years'
        }
    },
    
    resumeAnalysis: {
        extractedData: {
            name: { type: String, default: null },
            jobTitleText: { type: String, default: null },
            location: { type: String, default: null },
            email: { type: String, default: null },
            phone: { type: String, default: null },
            summary: { type: String, default: null },
            experience: { type: String, default: null },
            skills: [{ type: String, trim: true }],
            education: [{
                universityName: String,
                speciality: String,
                startYear: Number,
                endYear: Number
            }],
            achievements: [{ type: String, trim: true }],
            certifications: [{ type: String, trim: true }],
            age: { type: Number, default: null },
            gender: { type: String, default: null },
            city: { type: String, default: null },
            district: { type: String, default: null },
            jobRole: { type: String, default: null },
            specialtyFamily: { type: String, default: null },
            totalExperienceYears: { type: Number, default: null },
            experienceEntries: [{
                employer: { type: String, default: null },
                role: { type: String, default: null },
                startDate: { type: String, default: null },
                endDate: { type: String, default: null },
                isCurrent: { type: Boolean, default: false }
            }],
            // Derived from experienceEntries — the entry with isCurrent:true.
            currentEmployer: { type: String, default: null },
            expectedSalary: { type: String, default: null },
            registrationNumber: { type: String, default: null },
            // Derived — true only when registrationNumber is non-empty.
            hasRegistration: { type: Boolean, default: false }
        },
        score: {
            total: { type: Number, min: 0, max: 100 },
            breakdown: {
                education: { type: Number, min: 0, max: 20 },
                experience: { type: Number, min: 0, max: 20 },
                skills: { type: Number, min: 0, max: 20 },
                achievements: { type: Number, min: 0, max: 20 },
                certifications: { type: Number, min: 0, max: 20 }
            }
        },
        suggestions: [{ type: String, trim: true }],
        
        resumeScoreSummary: { type: String, default: null },
        resumeDocumentId: { type: mongoose.Schema.Types.ObjectId, default: null },
        analyzedAt: { type: Date, default: null }
    }
}, {
    timestamps: true
});


medicalStaffSchema.pre('save', function (next) {
    this.isProfileComplete = !!(
        this.jobRole && this.city && this.currentAddress && this.state &&
        this.pincode && this.phoneNumber && this.experience &&
        this.coordinates?.coordinates?.latitude != null &&
        this.coordinates?.coordinates?.longitude != null
    );
    next();
});



// Basic single-field indexes
medicalStaffSchema.index({ user: 1 });
medicalStaffSchema.index({ city: 1 });
medicalStaffSchema.index({ state: 1 });
medicalStaffSchema.index({ currentAddress: 1 });
medicalStaffSchema.index({ jobRole: 1 });
medicalStaffSchema.index({ assignedTo: 1 });

// Individual coordinate indexes (for bounding box queries)
medicalStaffSchema.index({ 'coordinates.coordinates.longitude': 1 });
medicalStaffSchema.index({ 'coordinates.coordinates.latitude': 1 });

// Essential compound indexes for performance
medicalStaffSchema.index({
    isAvailable: 1,         // filter only available staff
    jobRole: 1,             // filter by job role
    'coordinates.coordinates.latitude': 1,      // filter latitude range
    'coordinates.coordinates.longitude': 1      // filter longitude range
}); // For location-based duty notifications

// Compound indexes for availability and updates
medicalStaffSchema.index({
    user: 1,
    isAvailable: 1,
    updatedAt: -1
}); // Compound index for availability queries

medicalStaffSchema.index({
    isAvailable: 1,
    updatedAt: -1
}); // For real-time availability dashboard

medicalStaffSchema.index({ user: 1, updatedAt: -1 }); // For recent updates

// Virtual field for geospatial queries (returns [longitude, latitude]).
// Null-safe: a resume-driven profile may have no coordinates at all.
medicalStaffSchema.virtual('coordinatesArray').get(function () {
    const coords = this.coordinates?.coordinates;
    if (coords?.longitude == null || coords?.latitude == null) return undefined;
    return [coords.longitude, coords.latitude];
});

// 2dsphere index for MongoDB geospatial queries
medicalStaffSchema.index({ coordinatesArray: '2dsphere' });

medicalStaffSchema.index({ skills: 1 });
medicalStaffSchema.index({ 'education.speciality': 1 });

// Enhanced indexes for staff details optimization
medicalStaffSchema.index({
    verificationStatus: 1,
    averageRating: -1
}); // For staff quality queries

medicalStaffSchema.index({
    skills: 1,
    isAvailable: 1,
    'coordinates.coordinates.latitude': 1,
    'coordinates.coordinates.longitude': 1
}); // For skill-based location queries

// Compound indexes for verification status queries 
medicalStaffSchema.index({ user: 1, verificationStatus: 1 });

// Index for admin verification workflows 
medicalStaffSchema.index({ verificationStatus: 1, createdAt: -1 });

// Index for rejection tracking 
medicalStaffSchema.index({ verificationStatus: 1, rejectionReason: 1 });

// Index for cache invalidation queries 
medicalStaffSchema.index({ user: 1, verificationStatus: 1, rejectionReason: 1 });

// Indexes for suspension queries
medicalStaffSchema.index({ isSuspended: 1, createdAt: -1 });
medicalStaffSchema.index({ verificationStatus: 1, isSuspended: 1 });

// compound index for nearby staff queries 
medicalStaffSchema.index({
    isAvailable: 1,
    verificationStatus: 1,
    'coordinates.coordinates.latitude': 1,
    'coordinates.coordinates.longitude': 1,
    jobRole: 1
}); 

// Additional optimized indexes 
medicalStaffSchema.index({
    isAvailable: 1,
    'coordinates.coordinates.latitude': 1,
    'coordinates.coordinates.longitude': 1
}); // For bounding box queries

medicalStaffSchema.index({
    user: 1,
    isAvailable: 1,
    updatedAt: -1
}); // For availability updates

const MedicalStaff = mongoose.model('MedicalStaff', medicalStaffSchema);

module.exports = MedicalStaff;