const mongoose = require('mongoose');

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
    area: {
        type: String,
        required: [true, 'Area is required'],
        trim: true,
        maxlength: [100, 'Area cannot exceed 100 characters']
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
    isAvailable: {
        type: Boolean,
        default: true,
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
    totalExperience: {
        type: Number,
        min: 0,
        max: 50,
        default: 0
    }
}, {
    timestamps: true
});


// Basic indexes
medicalStaffSchema.index({ user: 1 });
medicalStaffSchema.index({ city: 1 });
medicalStaffSchema.index({ area: 1 });
medicalStaffSchema.index({ jobRole: 1 });

// Individual coordinate indexes (for bounding box queries)
medicalStaffSchema.index({ 'coordinates.coordinates.longitude': 1 });
medicalStaffSchema.index({ 'coordinates.coordinates.latitude': 1 });

// COMPOUND INDEX for optimal nearby staff queries
medicalStaffSchema.index({
    isAvailable: 1,         // filter only available staff
    'coordinates.coordinates.latitude': 1,      // filter latitude range
    'coordinates.coordinates.longitude': 1      // filter longitude range
});


// compound indexes for availability and updates
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

// Virtual field for geospatial queries (returns [longitude, latitude])
medicalStaffSchema.virtual('coordinatesArray').get(function () {
    return [this.coordinates.coordinates.longitude, this.coordinates.coordinates.latitude];
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

medicalStaffSchema.index({
    user: 1,
    'updatedAt': -1
}); // For recent updates


const MedicalStaff = mongoose.model('MedicalStaff', medicalStaffSchema);

module.exports = MedicalStaff;