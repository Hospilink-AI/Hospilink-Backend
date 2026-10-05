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
const autoRelistService = require('./autoRelist.service');
const locationBasedStaffService = require('./locationBasedStaff.service');
const notificationEmitter = require('./notificationEmitter');
const dutyOfferService = require('./dutyOffer.service');
const activityLogEmitter = require('./activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const systemConfigService = require('./systemConfig.service');
const {
    HOSPITAL_CANCEL_REASONS,
    STAFF_CANCEL_REASONS,
    HOSPITAL_OTHER_REASON,
    STAFF_OTHER_REASON
} = require('../utils/dutyCancellation.constants');

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

        // Validate reason enum — combined superset (defense-in-depth; the
        // route-level validateDutyCancellation middleware already narrows
        // this per-role before a request gets here).
        const validReasons = [...STAFF_CANCEL_REASONS, ...HOSPITAL_CANCEL_REASONS];
        if (!validReasons.includes(reason)) {
            return { allowed: false, error: `Invalid cancellation reason. Must be one of: ${validReasons.join(', ')}` };
        }

        // Validate reasonText for 'other' reasons
        if ((reason === STAFF_OTHER_REASON || reason === HOSPITAL_OTHER_REASON) && !reasonText) {
            return { allowed: false, error: 'Additional details (reasonText) required when selecting "other" as reason' };
        }

        // Role-based validation
        if (user.role === 'hospital') {
            return await this._validateHospitalCancellation(duty);
        }

        if (user.role === 'staff') {
            return await this._validateStaffCancellation(duty);
        }

        return { allowed: false, error: 'Only hospital and staff users can cancel duties'};
    }



    async _validateStaffCancellation(duty) {
        // Ownership is already checked in cancelDuty() before this runs.
        // Staff can only cancel a duty they currently hold.
        if (duty.status !== 'assigned') {
            return { allowed: false, error: 'Staff can only cancel duties with status: assigned' };
        }

        const staffCancelCutoffMinutes = await systemConfigService.getEffective('autoRelist.staffCancelCutoffMinutes');
        const minutesUntilStart = this._getMinutesUntilDutyStart(duty);
        if (minutesUntilStart < staffCancelCutoffMinutes) {
            return {
                allowed: false,
                error: `Cannot cancel a duty less than ${staffCancelCutoffMinutes} minutes before its start time. ` +
                    'This close to the shift, it is treated as a no-show rather than a cancellation — ' +
                    'contact the hospital or support directly.'
            };
        }

        return { allowed: true };
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



    // Minutes between now and duty start (can be negative if already
    // started). Used by staff cancellation for both the 30-minute cutoff
    // and the 90-minute late-cancellation band (see autoRelist.service.js).
    _getMinutesUntilDutyStart(duty) {
        const now = getCurrentIST();
        const dutyDate = new Date(duty.date);
        const [hours, minutes] = duty.startTime.split(':');

        const istDutyDate = toIST(dutyDate);
        const dutyStartTime = new Date(istDutyDate);
        dutyStartTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

        return (dutyStartTime.getTime() - now.getTime()) / (60 * 1000);
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

    

    async cancelDuty(dutyId, user, reason, reasonText, options = {}) {
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

        // Ownership check — branches by role. A staff member has no
        // Hospital profile (and vice versa), so this must not run the
        // hospital-ownership lookup unconditionally.
        let medicalStaff = null;

        if (user.role === 'hospital') {
            const hospital = await Hospital.findOne({ user: user._id });
            if (!hospital) {
                throw new NotFoundError('Hospital profile not found');
            }
            if (duty.hospital._id.toString() !== hospital._id.toString()) {
                throw new ForbiddenError('You can only cancel your own duties');
            }
        } else if (user.role === 'staff') {
            medicalStaff = await MedicalStaff.findOne({ user: user._id });
            if (!medicalStaff) {
                throw new NotFoundError('Medical staff profile not found');
            }
            if (!duty.assignedTo || duty.assignedTo._id.toString() !== medicalStaff._id.toString()) {
                throw new ForbiddenError('You can only cancel a duty assigned to you');
            }
        }

        // Validate cancellation
        const validation = await this.validateCancellation(duty, user, reason, reasonText);
        if (!validation.allowed) {
            if (validation.error.includes('already cancelled') ||
                validation.error.includes('Cannot cancel a completed duty') ||
                validation.error.includes('can only cancel duties with status')) {
                throw new ConflictError(validation.error);
            }
            if (validation.error.includes('Only hospital') && validation.error.includes('can cancel duties')) {
                throw new ForbiddenError(validation.error);
            }
            throw new ValidationError(validation.error);
        }

        if (user.role === 'staff') {
            return await this._finalizeStaffCancellation(duty, user, medicalStaff, reason, reasonText, options);
        }

        // Hospital cancellation — unchanged terminal behavior: the duty is
        // dead, full stop. (Staff cancellation never reaches this branch —
        // it always returns the duty to `available` instead; see above.)
        duty.status = 'cancelled';
        duty.cancellation = {
            cancelledBy: 'hospital',
            reason: reason,
            reasonText: reasonText || null,
            timestamp: getCurrentIST()
        };
        duty.statusHistory.push({
            status: 'cancelled',
            timestamp: getCurrentIST(),
            changedBy: user._id,
            reason: reasonText || reason
        });

        await duty.save();
        return duty;
    }



    // Staff cancellation never terminates the duty — it returns to
    // `available` and (unless the hospital opted out) runs through the
    // auto-relist engine: urgency escalation, the one-time late-band rate
    // boost, and a widened staff broadcast. The cancelling staff member is
    // permanently excluded from this duty either way.
    async _finalizeStaffCancellation(duty, user, medicalStaff, reason, reasonText, options = {}) {
        const minutesUntilStart = this._getMinutesUntilDutyStart(duty);

        const relistConfig = await systemConfigService.getManyEffective([
            'autoRelist.staffCancelCutoffMinutes',
            'autoRelist.lateCancellationBandMinutes',
            'autoRelist.rateBoostFraction',
            'autoRelist.relistCap'
        ]);

        duty.cancellation = {
            cancelledBy: 'staff',
            reason,
            reasonText: reasonText || null,
            timestamp: getCurrentIST()
        };
        duty.statusHistory.push({
            status: 'available',
            timestamp: getCurrentIST(),
            changedBy: user._id,
            reason: reasonText || reason
        });

        const relistOutcome = autoRelistService.applyRelist(duty, {
            cancellingStaffId: medicalStaff._id,
            minutesUntilStart,
            reason,
            reasonText,
            enabled: duty.autoRelist?.enabled !== false,
            config: {
                staffCancelCutoffMinutes: relistConfig['autoRelist.staffCancelCutoffMinutes'],
                lateCancellationBandMinutes: relistConfig['autoRelist.lateCancellationBandMinutes'],
                rateBoostFraction: relistConfig['autoRelist.rateBoostFraction'],
                relistCap: relistConfig['autoRelist.relistCap']
            }
        });

        duty.status = 'available';
        duty.assignedTo = null;
        duty.assignedAt = null;

        await duty.save();

        if (!relistOutcome.skipped) {
            // Fire-and-forget — the cancellation itself already succeeded
            // and is saved; a notification failure must not fail the request.
            this._notifyRelist(duty, relistOutcome).catch(err =>
                console.error('Failed to send auto-relist notifications:', err)
            );
        }

        this._logRelistActivity(duty, user, medicalStaff, reason, reasonText, relistOutcome).catch(err =>
            console.error('Failed to write auto-relist activity log:', err)
        );

        // Not when the doctor is deleting their account
        if (!options.skipWatchlist) {
            this._checkStaffWatchlist(medicalStaff).catch(err =>
                console.error('Failed to check staff cancellation watchlist:', err)
            );
        }

        return duty;
    }



    // Signal to look, never an automatic consequence — fires once, exactly when a staff member's late-band
    // cancellation count *crosses* the threshold, not on every cancellation
    // after. Never notifies the staff member themselves.
    async _checkStaffWatchlist(medicalStaff) {
        const cfg = await systemConfigService.getManyEffective([
            'autoRelist.staffWatchlistWindowDays',
            'autoRelist.staffWatchlistThresholdCount',
            'autoRelist.lateCancellationBandMinutes'
        ]);
        const windowDays = cfg['autoRelist.staffWatchlistWindowDays'];
        const thresholdCount = cfg['autoRelist.staffWatchlistThresholdCount'];

        const count = await autoRelistService.countStaffCancellations(medicalStaff._id, {
            windowDays,
            lateBandOnly: true,
            lateBandMinutes: cfg['autoRelist.lateCancellationBandMinutes']
        });

        if (count !== thresholdCount + 1) return;

        await notificationEmitter.emitOperationsAlert(
            'STAFF_CANCELLATION_WATCHLIST',
            `${medicalStaff.fullName || 'A staff member'} has cancelled ${count} duties in the late-cancellation band in the last ${windowDays} days.`,
            { medicalStaffId: medicalStaff._id.toString(), count, windowDays }
        );
    }



    async _logRelistActivity(duty, user, medicalStaff, reason, reasonText, relistOutcome) {
        const actor = {
            userId: user._id,
            name: medicalStaff.fullName || 'Staff',
            role: 'staff',
            email: 'unknown'
        };

        // Always logged — a staff cancellation always relists the duty whether or not the hospital opted into the escalation/boost/broadcast on top of that.
        await activityLogEmitter.emitDutyActivity(
            ACTIVITY_ACTIONS.DUTY_AUTO_RELISTED,
            duty, actor,
            { reason, reasonText, relistCount: relistOutcome.relistCount, autoRelistSkipped: relistOutcome.skipped }
        );

        if (relistOutcome.skipped) return;

        if (relistOutcome.urgencyBefore !== relistOutcome.urgencyAfter) {
            await activityLogEmitter.emitDutyActivity(
                ACTIVITY_ACTIONS.DUTY_URGENCY_ESCALATED,
                duty, actor,
                { urgencyBefore: relistOutcome.urgencyBefore, urgencyAfter: relistOutcome.urgencyAfter }
            );
        }

        if (relistOutcome.boosted) {
            await activityLogEmitter.emitDutyActivity(
                ACTIVITY_ACTIONS.DUTY_RATE_BOOSTED,
                duty, actor,
                { rateBefore: relistOutcome.rateBefore, rateAfter: relistOutcome.rateAfter }
            );
        }

        if (relistOutcome.capReached) {
            await activityLogEmitter.emitDutyActivity(
                ACTIVITY_ACTIONS.DUTY_RELIST_CAP_REACHED,
                duty, actor,
                { relistCount: relistOutcome.relistCount }
            );
        }
    }



    async _notifyRelist(duty, relistOutcome) {
        if (relistOutcome.capReached) {
            // Dispatch event, not a platform event — operations_manager only,
            // never super_admin. Independent of the widened-broadcast path below so it still fires even if the hospital's location data is missing.
            notificationEmitter.emitOperationsAlert(
                'DUTY_RELIST_CAP_REACHED',
                `${duty.staffRole} duty at ${duty.hospital?.hospitalLegalName || 'a hospital'} has been cancelled and relisted ${relistOutcome.relistCount} times — needs manual attention.`,
                { dutyId: duty._id.toString(), relistCount: relistOutcome.relistCount }
            ).catch(err => console.error('Failed to send operations cap-reached alert:', err));
        }

        const hospital = duty.hospital;
        const hospitalCoords = hospital?.coordinates?.coordinates;

        if (!hospital?.user?._id || !hospitalCoords?.latitude || !hospitalCoords?.longitude) {
            console.error(`Skipping relist broadcast for duty ${duty._id}: hospital location/user missing`);
            return;
        }

        const excludedIds = new Set(
            (duty.autoRelist.excludedStaff || []).map(id => id.toString())
        );

        const notificationRadiusKm = await systemConfigService.getEffective('autoRelist.notificationRadiusKm');
        const matchingStaff = await locationBasedStaffService.getNearbyStaffByRole(
            { latitude: hospitalCoords.latitude, longitude: hospitalCoords.longitude },
            duty.staffRole,
            100,
            notificationRadiusKm
        );

        const relistStaff = matchingStaff
            .filter(staff => staff.user && staff.user._id && !excludedIds.has(staff._id.toString()));
        const staffUserIds = relistStaff.map(staff => staff.user._id.toString());

        await dutyOfferService.onRelist(duty, relistStaff.map(staff => staff._id), notificationRadiusKm);

        await notificationEmitter.emitDutyRelisted(
            duty,
            hospital.user._id.toString(),
            staffUserIds,
            relistOutcome
        );
    }
}

module.exports = new CancellationService();