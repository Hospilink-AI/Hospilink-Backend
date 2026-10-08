const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const notificationEmitter = require('./notificationEmitter');
const blockService = require('./block.service');
const logger = require('../utils/logger');
const { getCurrentIST, toIST, formatRoleForDisplay } = require('../utils/helpers');
const { dutyHoursAndTotal, MAX_TOTAL, formatRupees } = require('../utils/dutyPricing');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
    ForbiddenError
} = require('../middleware/error.middleware');

// Raising is about filling a duty that is about to go unfilled, so it stays
// open until a minute before the start (ordinary edits close 30 minutes before)
const RAISE_DEADLINE_MS = 60 * 1000;

function scheduledStart(duty) {
    const [hours, minutes] = duty.startTime.split(':').map(Number);
    const start = new Date(toIST(new Date(duty.date)));
    start.setHours(hours, minutes, 0, 0);
    return start;
}

class DutyRateRaiseService {
    // A hospital raises the hourly rate of its own open duty, like adding a tip
    async raise(dutyId, hospitalUserId, newRate) {
        const hospital = await Hospital.findOne({ user: hospitalUserId }).select('_id hospitalLegalName').lean();
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId)
            .select('+offer.notifiedStaff hospital status offeredRate totalPayment date endDate startTime endTime isOvernightDuty staffRole urgency category pricing offer.invitedStaff autoRelist.excludedStaff')
            .lean();
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }
        if (String(duty.hospital) !== String(hospital._id)) {
            throw new ForbiddenError('You can only raise the rate of your own duties');
        }
        if (duty.status !== 'available') {
            throw new ValidationError('You can only raise the rate while the duty is open.');
        }
        if (duty.pricing?.mode === 'fixed') {
            throw new ValidationError('Anesthesia bookings have one price for the case.');
        }
        if (getCurrentIST() >= new Date(scheduledStart(duty).getTime() - RAISE_DEADLINE_MS)) {
            throw new ValidationError('The duty is about to start, so the rate can no longer change.');
        }

        const previousRate = duty.offeredRate || 0;
        if (!(newRate > previousRate)) {
            throw new ValidationError(`The new rate must be higher than ${formatRupees(previousRate)}/hr.`);
        }

        const priced = dutyHoursAndTotal({ ...duty, offeredRate: newRate });
        if (!priced) {
            throw new ValidationError('This duty has no valid times to price.');
        }
        if (priced.total > MAX_TOTAL) {
            throw new ValidationError(`The total can't be more than ${formatRupees(MAX_TOTAL)}.`);
        }

        const raisedAt = getCurrentIST();
        const record = { previousRate, raisedAt, by: hospitalUserId };

        // Only if nobody accepted or changed the rate in the meantime
        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: 'available', offeredRate: duty.offeredRate },
            {
                $set: { offeredRate: newRate, totalPayment: priced.total, rateRaise: record },
                $push: { rateRaises: { ...record, newRate } }
            },
            { new: true }
        );
        if (!updated) {
            throw new ConflictError('The duty changed while you were raising the rate. Please try again.');
        }

        this._notifyOffered(duty, updated, hospital).catch(err =>
            logger.error(`Error notifying doctors of a raised rate for duty ${dutyId}: ${err.message}`));

        return updated;
    }

    // Doctors who were already offered the duty (staged ring or invite) hear
    // about the new rate. Doctors not yet told get the new rate when they are.
    async _notifyOffered(duty, updated, hospital) {
        const excluded = new Set((duty.autoRelist?.excludedStaff || []).map(String));
        const hidden = new Set(await blockService.staffHiddenFrom(hospital._id));
        const staffIds = [...new Set([
            ...(duty.offer?.notifiedStaff || []),
            ...(duty.offer?.invitedStaff || [])
        ].map(String))].filter(id => !excluded.has(id) && !hidden.has(id));
        if (staffIds.length === 0) return;

        const staff = await MedicalStaff.find({ _id: { $in: staffIds } }).select('user').lean();
        const userIds = staff.map(s => s.user).filter(Boolean).map(String);
        if (userIds.length === 0) return;

        const day = new Date(updated.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
        const role = formatRoleForDisplay(updated.staffRole || '');
        const message = `Rate raised to ${formatRupees(updated.offeredRate)}/hr: ${role} at ${hospital.hospitalLegalName || 'a hospital'}, ${day} ${updated.startTime}.`;

        await notificationEmitter.emitDutyNotice('NEW_DUTY_OFFER', updated, userIds, message, {
            rateRaise: {
                previousRate: updated.rateRaise.previousRate,
                newRate: updated.offeredRate,
                raisedAt: updated.rateRaise.raisedAt
            }
        });
    }
}

module.exports = new DutyRateRaiseService();
