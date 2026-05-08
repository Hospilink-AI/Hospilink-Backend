const mongoose = require('mongoose');
const { toIST, getCurrentIST, calculateDutyDuration } = require('../utils/helpers');

const dutySchema = new mongoose.Schema({
    hospital: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hospital',
        required: [true, 'Hospital reference is required']
    },
    staffRole: {
        type: String,
        required: [true, 'Staff role is required'],
        enum: [
            // Doctors
            'rmo', 'dmo', 'general_physician', 'intensivist', 'emergency_doctor',
            'anesthetist', 'pediatrician', 'gynecologist', 'orthopedic_surgeon',
            'general_surgeon', 'radiologist', 'pathologist',
            // Nursing Staff
            'staff_nurse', 'icu_nurse', 'emergency_nurse', 'ot_nurse',
            'dialysis_nurse', 'nicu_nurse',
            // Technical Staff
            'lab_technician', 'radiology_technician', 'ot_technician',
            'dialysis_technician', 'cath_lab_technician', 'icu_technician',
            // Support Staff
            'ward_boy', 'ayah', 'opd_attendant', 'emergency_attendant',
            'patient_care_taker',
            // Pharmacy & Allied
            'pharmacist', 'pharmacy_assistant', 'biomedical_engineer',
            // Housekeeping & Facility
            'housekeeping_staff', 'security_guard', 'ambulance_driver',
            // Administrative
            'receptionist', 'billing_executive', 'medical_records_staff', 'hr_accounts'
        ]
    },
    date: {
        type: Date,
        required: [true, 'Start date is required']
    },
    endDate: {
        type: Date,
        required: false,
        validate: {
            validator: function (v) {
                // If endDate is provided, it should be >= startDate
                if (v && this.date) {
                    return v >= this.date;
                }
                return true;
            },
            message: 'End date must be on or after start date'
        }
    },
    startTime: {
        type: String,
        required: [true, 'Start time is required'],
        validate: {
            validator: function (v) {
                return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
            },
            message: 'Start time must be in HH:MM format'
        }
    },
    endTime: {
        type: String,
        required: [true, 'End time is required'],
        validate: {
            validator: function (v) {
                return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(v);
            },
            message: 'End time must be in HH:MM format'
        }
    },
    isOvernightDuty: {
        type: Boolean,
        default: false
    },
    urgency: {
        type: String,
        required: [true, 'Urgency level is required'],
        enum: {
            values: ['low', 'medium', 'high','emergency'],
            message: 'Urgency must be one of: low, medium, high, emergency'
        },
        default: 'medium'
    },
    description: {
        type: String,
        maxlength: [1000, 'Description cannot exceed 1000 characters']
    },
    offeredRate: {
        type: Number,
        min: [0, 'Offered rate cannot be negative']
    },
    totalPayment: {
        type: Number,
        min: [0, 'Total payment cannot be negative'],
        default: 0
    },

    status: {
        type: String,
        enum: ['available', 'assigned', 'enroute', 'in-progress', 'completed', 'cancelled', 'expired', 'incomplete'],
        default: 'available',
        required: true
    },

    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MedicalStaff',
        default: null
    },

    statusHistory: [{
        status: {
            type: String,
            enum: ['available', 'assigned', 'enroute', 'in-progress', 'completed', 'cancelled', 'expired', 'incomplete'],
            required: true
        },
        timestamp: {
            type: Date,
            default: Date.now,
            required: true
        },
        changedBy: {
            type: mongoose.Schema.Types.Mixed,  // Allow both ObjectId and string
            required: true
        },
        reason: String  // For cancellations
    }],

    cancellation: {
        cancelledBy: {
            type: String,
            enum: ['staff', 'hospital']
        },
        reason: {
            type: String,
            enum: [
                // Staff reasons
                'emergency', 'illness', 'scheduling_conflict', 'transportation_issue', 'other_staff',
                // Hospital reasons
                'no_longer_needed', 'found_alternative', 'emergency_resolved', 'budget_constraints', 'other_hospital'
            ]
        },
        reasonText: String,  // Required when reason is 'other_staff' or 'other_hospital'
        timestamp: { type: Date, default: null }
    },

    
    assignedAt: {
        type: Date,
        default: null
    },

    enrouteAt: Date,  // When status changed to 'enroute'

    startedAt: Date,  // When status changed to 'in-progress'

    completedAt: {
        type: Date,
        default: null
    },
    expiredAt: {
        type: Date,
        default: null
    },
    incompleteAt: {
        type: Date,
        default: null
    },
    unassigned15MinNotified: {
        type: Boolean,
        default: false
    },
    unfilledCriticalNotified: {
        type: Boolean,
        default: false
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
    timestamps: true,
    // Custom transform to handle IST properly
    toJSON: {
        virtuals: true, transform: function (doc, ret) {
            // Convert all dates to IST for JSON output
            const dateFields = ['createdAt', 'updatedAt', 'assignedAt', 'enrouteAt', 'startedAt', 'completedAt'];
            dateFields.forEach(field => {
                if (ret[field]) {
                    ret[field] = new Date(ret[field].getTime() + (5.5 * 60 * 60 * 1000));
                }
            });

            // Convert statusHistory timestamps
            if (ret.statusHistory) {
                ret.statusHistory.forEach(entry => {
                    if (entry.timestamp) {
                        entry.timestamp = new Date(entry.timestamp.getTime() + (5.5 * 60 * 60 * 1000));
                    }
                });
            }

            return ret;
        }
    },
});


// Status validation methods
dutySchema.methods.canChangeStatus = function (newStatus, userId) {
    // Validate staff assignment
    if (!this.assignedTo || this.assignedTo.toString() !== userId.toString()) {
        return { allowed: false, reason: 'You can only change status for duties assigned to you' };
    }

    // Define valid status transitions
    const validTransitions = {
        'available': ['assigned', 'cancelled', 'expired'],
        'assigned': ['enroute', 'cancelled', 'incomplete'],
        'enroute': ['in-progress', 'cancelled', 'incomplete'],
        'in-progress': ['completed', 'cancelled', 'incomplete'],
        'completed': [], // No transitions from completed
        'cancelled': [], // No transitions from cancelled
        'expired': [], // No transitions from expired
        'incomplete': [] // No transitions from incomplete
    };

    if (!validTransitions[this.status].includes(newStatus)) {
        return { allowed: false, reason: `Cannot change from ${this.status} to ${newStatus}` };
    }

    return { allowed: true };
};


dutySchema.methods.isWithinStartBuffer = function () {
    // Use getCurrentIST() for consistent time handling
    const now = getCurrentIST();
    const dutyDate = new Date(this.date);
    const [hours, minutes] = this.startTime.split(':');

    // Convert duty date to IST first, then set time
    const istDutyDate = toIST(dutyDate);
    const dutyStartTime = new Date(istDutyDate);
    dutyStartTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    // 15 minutes before and after start time
    const bufferStart = new Date(dutyStartTime.getTime() - 15 * 60 * 1000);
    const bufferEnd = new Date(dutyStartTime.getTime() + 15 * 60 * 1000);

    return now >= bufferStart && now <= bufferEnd;
};


dutySchema.methods.isAtEndTime = function () {
    // Use getCurrentIST() for consistent time handling
    const now = getCurrentIST();
    const dutyDate = new Date(this.date);
    const [hours, minutes] = this.endTime.split(':');

    // Convert duty date to IST first, then set time
    const istDutyDate = toIST(dutyDate);
    const dutyEndTime = new Date(istDutyDate);
    dutyEndTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    // Check if current time is at or past end time (within 1 minute tolerance)
    const timeDiff = Math.abs(now.getTime() - dutyEndTime.getTime());
    return timeDiff <= 60 * 1000; // 1 minute tolerance
};


dutySchema.methods.canStartDuty = function () {
    if (this.status !== 'enroute') {
        return { allowed: false, reason: 'Duty must be enroute before starting' };
    }

    if (!this.isWithinStartBuffer()) {
        return { allowed: false, reason: 'Can only start duty within 15 minutes of start time' };
    }

    return { allowed: true };
};


dutySchema.methods.canCompleteDuty = function () {
    if (this.status !== 'in-progress') {
        return { allowed: false, reason: 'Duty must be in progress before completion' };
    }

    // Use getCurrentIST() for consistent time handling
    const now = getCurrentIST();
    const dutyDate = new Date(this.date);
    const [hours, minutes] = this.endTime.split(':');

    // Convert duty date to IST first, then set. time
    const istDutyDate = toIST(dutyDate);
    const istDutyEndTime = new Date(istDutyDate);
    istDutyEndTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    // Allow manual completion from end time until 15 minutes after
    const bufferEndTime = new Date(istDutyEndTime.getTime() + 15 * 60 * 1000);

    if (now < istDutyEndTime) {
        return { allowed: false, reason: 'Can only complete duty at or after scheduled end time' };
    }
    if (now > bufferEndTime) {
        return { allowed: false, reason: 'Duty was automatically completed (15 minute window expired)' };
    }

    return { allowed: true };
};


dutySchema.methods.canEditDuty = function () {
    // Only allow editing for duties that are not yet started
    if (!['available'].includes(this.status)) {
        return { allowed: false, reason: 'Cannot edit duty that is already assigned, enroute, in-progress or completed' };
    }

    // Check if current time is more than 30 minutes before duty start time
    const now = getCurrentIST();
    const dutyDate = new Date(this.date);
    const [hours, minutes] = this.startTime.split(':');

    // Convert duty date to IST first, then set time
    const istDutyDate = toIST(dutyDate);
    const dutyStartTime = new Date(istDutyDate);
    dutyStartTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    // Calculate 30 minutes buffer before start time
    const editDeadline = new Date(dutyStartTime.getTime() - 30 * 60 * 1000);

    if (now >= editDeadline) {
        return { allowed: false, reason: 'Cannot edit duty within 30 minutes of start time' };
    }

    return { allowed: true };
};


// Pricing-only edit allowed for emergency duties until 1 min before start
dutySchema.methods.canEditPricing = function () {
    if (this.urgency !== 'emergency') {
        return { allowed: false, reason: 'Pricing-only edit is only available for Emergency duties' };
    }

    const now = getCurrentIST();
    const dutyDate = new Date(this.date);
    const [hours, minutes] = this.startTime.split(':');
    const istDutyDate = toIST(dutyDate);
    const dutyStartTime = new Date(istDutyDate);
    dutyStartTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    // Allow until 1 minute before start
    const pricingDeadline = new Date(dutyStartTime.getTime() - 60 * 1000);
    if (now >= pricingDeadline) {
        return { allowed: false, reason: 'Pricing can no longer be edited within 1 minute of duty start time' };
    }

    return { allowed: true };
};


// Pre-save hook for automatic total payment calculation
dutySchema.pre('save', function (next) {
    try {
        // Check if any calculation-relevant fields are modified or this is a new document
        const isNew = this.isNew;
        const relevantFieldsModified = this.isModified('offeredRate') ||
            this.isModified('startTime') ||
            this.isModified('endTime') ||
            this.isModified('date') ||
            this.isModified('endDate') ||
            this.isModified('isOvernightDuty');

        if (isNew || relevantFieldsModified) {
            // Validate required fields
            if (!this.offeredRate || !this.startTime || !this.endTime || !this.date) {
                this.totalPayment = 0;
                return next();
            }

            // Validate time format
            const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
            if (!timeRegex.test(this.startTime) || !timeRegex.test(this.endTime)) {
                this.totalPayment = 0;
                return next();
            }

            // Validate offeredRate is non-negative
            if (this.offeredRate < 0) {
                this.totalPayment = 0;
                return next();
            }

            // Calculate duration
            const duration = calculateDutyDuration(
                this.date,
                this.startTime,
                this.endTime,
                this.isOvernightDuty,
                this.endDate
            );

            // Calculate total payment and round to 2 decimal places
            this.totalPayment = Math.round(this.offeredRate * duration * 100) / 100;
        }

        next();
    } catch (error) {
        console.error('Error calculating total payment:', error);
        this.totalPayment = 0;
        next();
    }
});




// Basic single-field indexes
dutySchema.index({ hospital: 1 });
dutySchema.index({ staffRole: 1 });
dutySchema.index({ date: 1 });
dutySchema.index({ status: 1 });
dutySchema.index({ createdAt: -1 });
dutySchema.index({ totalPayment: 1 });
dutySchema.index({ assignedTo: 1 });

// Essential compound indexes for performance
dutySchema.index({ hospital: 1, status: 1 });
dutySchema.index({ staffRole: 1, status: 1, date: 1 });
dutySchema.index({ createdAt: 1, status: 1 });

// Optimized indexes for staff duty status 
dutySchema.index({ 
    assignedTo: 1, 
    status: 1, 
    date: 1 
}); // For staff duty status lookup

dutySchema.index({ 
    assignedTo: 1, 
    status: { $in: ['assigned', 'enroute', 'in-progress'] }, 
    date: 1 
}); // For active duties

dutySchema.index({ 
    assignedTo: 1, 
    status: 'available', 
    date: { $gte: new Date(), $lte: new Date(Date.now() + 7*24*60*60*1000) }
}); // For upcoming duties (next 7 days)

dutySchema.index({ 
    assignedTo: 1, 
    date: 1, 
    startTime: 1,
    endTime: 1
}); // For time-based duty queries

// Enhanced indexes for route map optimization
dutySchema.index({ 
    assignedTo: 1, 
    status: 1, 
    date: -1 
}); // For active duty queries (optimized)

dutySchema.index({ 
    status: 1, 
    assignedTo: 1, 
    'assignedAt': -1 
}); // For real-time tracking

dutySchema.index({ 
    hospital: 1, 
    status: 1, 
    date: -1 
}); // For hospital-specific queries 

// TTL index for status history cleanup (90 days)
dutySchema.index({ 
    'statusHistory.timestamp': 1 
}, { 
    expireAfterSeconds: 7776000 // 90 days
});



// Virtual for formatted role name
dutySchema.virtual('formattedRole').get(function () {
    const roleNames = {
        rmo: "RMO (Resident Medical Officer)",
        dmo: "Duty Medical Officer (DMO)",
        general_physician: "General Physician",
        intensivist: "Intensivist / ICU Doctor",
        emergency_doctor: "Emergency Medicine Doctor",
        anesthetist: "Anesthetist",
        pediatrician: "Pediatrician (NICU/PICU)",
        gynecologist: "Gynecologist (On-call)",
        orthopedic_surgeon: "Orthopedic Surgeon",
        general_surgeon: "General Surgeon",
        radiologist: "Radiologist",
        pathologist: "Pathologist",
        staff_nurse: "Staff Nurse (Ward)",
        icu_nurse: "ICU Nurse",
        emergency_nurse: "Emergency Nurse",
        ot_nurse: "OT Nurse",
        dialysis_nurse: "Dialysis Nurse",
        nicu_nurse: "NICU / PICU Nurse",
        lab_technician: "Lab Technician",
        radiology_technician: "Radiology Technician",
        ot_technician: "OT Technician",
        dialysis_technician: "Dialysis Technician",
        cath_lab_technician: "Cath Lab Technician",
        icu_technician: "ICU Technician",
        ward_boy: "Ward Boy",
        ayah: "Ayah / Female Attendant",
        opd_attendant: "OPD Attendant",
        emergency_attendant: "Emergency Attendant",
        patient_care_taker: "Patient Care Taker",
        pharmacist: "Pharmacist",
        pharmacy_assistant: "Pharmacy Assistant",
        biomedical_engineer: "Biomedical Engineer",
        housekeeping_staff: "Housekeeping Staff",
        security_guard: "Security Guard",
        ambulance_driver: "Ambulance Driver",
        receptionist: "Receptionist",
        billing_executive: "Billing Executive",
        medical_records_staff: "Medical Records Staff",
        hr_accounts: "HR & Accounts",
    };
    return roleNames[this.staffRole] || this.staffRole;
});


const Duty = mongoose.model('Duty', dutySchema);

module.exports = Duty;