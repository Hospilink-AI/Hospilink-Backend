const mongoose = require('mongoose');
const { ALLOWED_ROLES } = require('../utils/constants');

const jobVacancySchema = new mongoose.Schema({
    hospitalId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hospital',
        required: [true, 'Hospital reference is required']
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'Creator reference is required']
    },
    title: {
        type: String,
        required: [true, 'Title is required'],
        trim: true,
        maxlength: [200, 'Title cannot exceed 200 characters']
    },
    specialty: {
        type: String,
        required: [true, 'Specialty is required'],
        trim: true,
        enum: {
            values: ALLOWED_ROLES,
            message: 'specialty must be one of the allowed roles: ' + ALLOWED_ROLES.join(', ')
        }
    },
    experience: {
        type: String,
        trim: true,
        maxlength: [50, 'Experience cannot exceed 50 characters']
    },
    education: {
        type: String,
        trim: true,
        maxlength: [200, 'Education cannot exceed 200 characters']
    },
    skills: {
        type: [String],
        default: []
    },
    location: {
        type: String,
        trim: true,
        maxlength: [200, 'Location cannot exceed 200 characters']
    },
    salary: {
        type: String,
        trim: true,
        maxlength: [100, 'Salary cannot exceed 100 characters']
    },
    description: {
        type: String,
        required: [true, 'Description is required'],
        trim: true,
        maxlength: [3000, 'Description cannot exceed 3000 characters']
    },
    // The only lifecycle field — a vacancy is live from creation; this is the sole
    // way to take it down. There is deliberately no `status` enum (draft/published/
    // closed) for this model.
    deletedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

// Hospital's own listing view (mine) and ownership checks
jobVacancySchema.index({ hospitalId: 1, deletedAt: 1 });
// Candidate/public search — specialty is the first-class filter
jobVacancySchema.index({ specialty: 1, deletedAt: 1 });
// Admin default sort
jobVacancySchema.index({ createdAt: -1 });

const JobVacancy = mongoose.model('JobVacancy', jobVacancySchema);

module.exports = JobVacancy;
