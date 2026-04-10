const mongoose = require('mongoose');

const hospitalSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'User reference is required'],
        unique: true
    },
    hospitalLegalName: {
        type: String,
        required: [true, 'Hospital legal name is required'],
        trim: true,
        maxlength: [200, 'Hospital legal name cannot exceed 200 characters']
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
    currentAddress: {
        type: String,
        required: [true, 'Current address is required'],
        trim: true,
        maxlength: [300, 'Current address cannot exceed 300 characters']
    },
    location: {
        type: String,
        required: [true, 'Location is required'],
        trim: true,
        maxlength: [300, 'Location cannot exceed 300 characters']
    },
    // Update coordinates to use named properties
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
    servicesAvailable: [{
        type: String,
        required: true,
        enum: [
            'Emergency Care',
            'General Surgery',
            'Cardiology',
            'Neurology',
            'Orthopedics',
            'Pediatrics',
            'Obstetrics & Gynecology',
            'Internal Medicine',
            'Radiology',
            'Laboratory Services',
            'Pharmacy',
            'Physical Therapy',
            'Mental Health',
            'Oncology',
            'Dermatology',
            'Ophthalmology',
            'ENT (Ear, Nose, Throat)',
            'Urology',
            'Gastroenterology',
            'Pulmonology'
        ]
    }],
    staffCount: {
        type: String,
        required: [true, 'Staff count is required'],
        enum: {
            values: ['2-10', '11-50', '51-100', '100+'],
            message: 'Staff count must be one of: 2-10, 11-50, 51-100, 100+'
        }
    },
    isProfileComplete: {
        type: Boolean,
        default: true
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
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Index for faster queries - Update index for new format
hospitalSchema.index({ user: 1 });
hospitalSchema.index({ 'coordinates.coordinates.longitude': 1 });
hospitalSchema.index({ 'coordinates.coordinates.latitude': 1 });
hospitalSchema.index({ servicesAvailable: 1 });
// For geospatial queries, we need to create a virtual field that returns array format
hospitalSchema.virtual('coordinatesArray').get(function () {
    return [this.coordinates.coordinates.latitude, this.coordinates.coordinates.longitude];
});
hospitalSchema.index({ coordinatesArray: '2dsphere' });

hospitalSchema.index({ user: 1, updatedAt: -1 }); // For recent updates

const Hospital = mongoose.model('Hospital', hospitalSchema);

module.exports = Hospital;