const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const { getCurrentIST, toIST } = require('../utils/helpers');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
    ForbiddenError
} = require('../middleware/error.middleware');

class CancellationService {

    async validateCancellation(duty, user, reason, reasonText) {
        // Check if duty is already cancelled
        if (duty.status === 'cancelled') {
            return { allowed: false, error: 'Duty is already cancelled' };
        }

        // Check if duty is completed
        if (duty.status === 'completed') {
            return { allowed: false, error: 'Cannot cancel a completed duty' };
        }

        // Validate reason is provided
        if (!reason) {
            return { allowed: false, error: 'Cancellation reason is required' };
        }

        // Validate reason enum
        const validReasons = [
            'emergency', 'illness', 'scheduling_conflict', 'transportation_issue', 'other_staff',
            'no_longer_needed', 'found_alternative', 'emergency_resolved', 'budget_constraints', 'other_hospital'
        ];
        if (!validReasons.includes(reason)) {
            return { allowed: false, error: `Invalid cancellation reason. Must be one of: ${validReasons.join(', ')}` };
        }

        // Validate reasonText for 'other' reasons
        if ((reason === 'other_staff' || reason === 'other_hospital') && !reasonText) {
            return { allowed: false, error: 'Additional details (reasonText) required when selecting "other" as reason' };
        }

        // Role-based validation
        if (user.role === 'hospital') {
            return await this._validateHospitalCancellation(duty);
        }

        return { allowed: false, error: 'Only hospital users can cancel duties'};
    }

    

    async _validateHospitalCancellation(duty) {
        const status = duty.status;

        // Hospital can cancel duties with status 'available' or 'assigned'
        if (!['available', 'assigned'].includes(status)) {
            return { allowed: false, error: 'Hospital users can only cancel duties with status: available or assigned' };
        }
        
        // Check time restriction (must be more than 30 minutes before start time)
        if (!await this.canCancelWithin30MinutesWindow(duty)) {
            return { 
                allowed: false, 
                error: 'Cannot cancel duty less than 30 minutes before start time. Cancellation window closes 30 minutes prior to duty start time.' 
            };
        }
        
        return { allowed: true };
    }

    

    async canCancelWithin30MinutesWindow(duty) {
        const now = getCurrentIST();
        const dutyDate = new Date(duty.date);
        const [hours, minutes] = duty.startTime.split(':');
        
        // Convert duty date to IST first, then set time
        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
        
        // Calculate 30 minutes before start time (cutoff time)
        const cutoffTime = new Date(dutyStartTime.getTime() - 30 * 60 * 1000);
        
        // Hospital can cancel if current time is before or at cutoff time
        return now <= cutoffTime;
    }

    

    async shouldSendNotifications(status) {
        // Send notifications for assigned, enroute, and in-progress
        // Do NOT send for available
        return ['assigned', 'enroute', 'in-progress'].includes(status);
    }

    

    async isWithinOneHourOfStart(duty) {
        const now = getCurrentIST();
        const dutyDate = new Date(duty.date);
        const [hours, minutes] = duty.startTime.split(':');
        
        // Convert duty date to IST first, then set time
        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
        
        // Calculate 1 hour after start time
        const oneHourAfterStart = new Date(dutyStartTime.getTime() + 60 * 60 * 1000);
        
        // Check if current time is within the window (start time to 1 hour after)
        return now >= dutyStartTime && now <= oneHourAfterStart;
    }

    

    async cancelDuty(dutyId, user, reason, reasonText) {
        // Fetch duty from database
        const duty = await Duty.findById(dutyId)
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .populate({
                path: 'assignedTo',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            });

        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        // For hospital users, verify they own this duty
        const hospital = await Hospital.findOne({ user: user._id });
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found');
        }
        // Check if this duty belongs to this hospital
        if (duty.hospital._id.toString() !== hospital._id.toString()) {
            throw new ForbiddenError('You can only cancel your own duties');
        }

        // Validate cancellation
        const validation = await this.validateCancellation(duty, user, reason, reasonText);
        if (!validation.allowed) {
            if (validation.error.includes('already cancelled') ||
                validation.error.includes('Cannot cancel a completed duty') ||
                validation.error.includes('can only cancel duties with status')) {
                throw new ConflictError(validation.error);
            }
            if (validation.error.includes('Only hospital users can cancel duties')) {
                throw new ForbiddenError(validation.error);
            }
            throw new ValidationError(validation.error);
        }

        // Update duty status to cancelled
        duty.status = 'cancelled';

        // Set cancellation metadata
        duty.cancellation = {
            cancelledBy: user.role === 'hospital' ? 'hospital' : 'staff',
            reason: reason,
            reasonText: reasonText || null,
            timestamp: getCurrentIST()
        };

        // Add entry to statusHistory
        duty.statusHistory.push({
            status: 'cancelled',
            timestamp: getCurrentIST(),
            changedBy: user._id,
            reason: reasonText || reason
        });

        // Save duty to database
        await duty.save();

        return duty;
    }
}

module.exports = new CancellationService();