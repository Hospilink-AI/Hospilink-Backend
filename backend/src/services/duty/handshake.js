// Duties: the start and end codes (OTP handshake) between doctor and hospital
// Methods of DutyService; mixed into the class in ../duty.service.js, so `this` is the service.
const Duty = require('../../models/Duty');
const Hospital = require('../../models/Hospital');
const MedicalStaff = require('../../models/MedicalStaff');
const { toIST, getCurrentIST } = require('../../utils/helpers');
const notificationEmitter = require('../notificationEmitter');
const OTPService = require('../otp.service');
const SMSService = require('../sms.service');
const { isWithinGeofence, GEOFENCE_RADIUS_KM } = require('../geofence.service');
const {
    ValidationError,
    NotFoundError,
    ConflictError,
    ForbiddenError
} = require('../../middleware/error.middleware');
const { resolveStaffLocation } = require('./helpers');

module.exports = {
    // Staff taps "Get OTP to mark as in-progress" once they're within range of the hospital.
    // Re-checks the geofence server-side against the submitted coordinates, mints a Start OTP,
    // and sends it via SMS to the hospital's registered phone number. The hospital reads the
    // code aloud to the staff member, who then submits it via verify-start-otp.
    async requestStartOtp(dutyId, userId, sentLocation = null) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId).populate('hospital');
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
            throw new ForbiddenError('You can only request a start OTP for duties assigned to you');
        }

        // Idempotency: already verified and moved to in-progress
        if (duty.status === 'in-progress' && duty.startOtp.status === 'VERIFIED') {
            return { duty, alreadyInProgress: true, expiresAt: null };
        }

        if (duty.status !== 'enroute') {
            throw new ValidationError('Duty must be enroute before requesting a start OTP');
        }

        if (duty.startOtp.status === 'LOCKED') {
            throw new ForbiddenError('Start OTP is locked — contact admin support');
        }

        // Time-window guard: OTP can only be requested within ±bufferMinutes of scheduled start.
        // Enforced at generation — never issue a code when the check-in window is closed.
        const now = getCurrentIST();
        const bufferMinutes = 15;
        const [startHours, startMinutes] = duty.startTime.split(':').map(Number);
        const istDutyDate = toIST(new Date(duty.date));
        const scheduledStartTime = new Date(istDutyDate);
        scheduledStartTime.setHours(startHours, startMinutes, 0, 0);

        const windowStart = new Date(scheduledStartTime.getTime() - bufferMinutes * 60 * 1000);
        const windowEnd   = new Date(scheduledStartTime.getTime() + bufferMinutes * 60 * 1000);

        if (now < windowStart) {
            const opensAt  = windowStart.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
            const startsAt = scheduledStartTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
            throw new ValidationError(
                `Check-in window has not opened yet. You can request a start OTP from ${opensAt} (${bufferMinutes} minutes before your ${startsAt} duty start).`
            );
        }

        if (now > windowEnd) {
            const windowStartStr = windowStart.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
            const windowEndStr   = windowEnd.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
            throw new ValidationError(
                `Check-in window has closed. The start OTP window was ${windowStartStr} – ${windowEndStr}. Please contact admin if you need assistance.`
            );
        }

        const hospitalLat = duty.hospital?.coordinates?.coordinates?.latitude;
        const hospitalLng = duty.hospital?.coordinates?.coordinates?.longitude;
        if (typeof hospitalLat !== 'number' || typeof hospitalLng !== 'number') {
            throw new ValidationError('Hospital location is not configured — contact support');
        }

        const staffLocation = await resolveStaffLocation(userId, sentLocation);
        if (!staffLocation) {
            throw new ValidationError('Unable to determine your current location. Ensure the app is online and sharing live GPS to the server.');
        }

        if (!isWithinGeofence(staffLocation.latitude, staffLocation.longitude, hospitalLat, hospitalLng)) {
            const radiusMeters = Math.round(GEOFENCE_RADIUS_KM * 1000);
            throw new ValidationError(`You must be within ${radiusMeters}m of the hospital to request a start OTP`);
        }

        const code = OTPService.generateOTP();
        const expiryMinutes = parseInt(process.env.DUTY_START_OTP_EXPIRY_MINUTES) || 5;
        const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000);

        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: 'enroute' },
            {
                $set: {
                    'startOtp.code': code,
                    'startOtp.expiresAt': expiresAt,
                    'startOtp.attempts': 0,
                    'startOtp.status': 'PENDING',
                    'startOtp.sentAt': now
                }
            },
            { new: true }
        );

        if (!updated) {
            throw new ConflictError('Duty status changed — cannot request start OTP');
        }

        await this._sendHospitalOtpSms(duty.hospital, code, dutyId);

        return { duty: updated, alreadyInProgress: false, expiresAt: updated.startOtp.expiresAt };
    },

    // Sends an OTP code to the staff member's own registered phone via SMS. Failures are
    // logged but never thrown — OTP delivery issues shouldn't block the request/response.
    async _sendStaffOtpSms(medicalStaff, code, dutyId, otpType) {
        if (!medicalStaff?.phoneNumber) {
            return;
        }
        try {
            await SMSService.sendOTPSMS(medicalStaff.phoneNumber, code, medicalStaff.fullName);
        } catch (smsError) {
            console.error(`Error sending ${otpType} OTP SMS for duty ${dutyId}:`, smsError);
        }
    },

    // Sends a Start OTP to the hospital's registered phone via SMS so the hospital can read
    // it aloud to the arriving staff member. Failures are logged but never thrown.
    async _sendHospitalOtpSms(hospital, code, dutyId) {
        if (!hospital?.phoneNumber) {
            return;
        }
        try {
            await SMSService.sendOTPSMS(hospital.phoneNumber, code, hospital.hospitalLegalName);
        } catch (smsError) {
            console.error(`Error sending start OTP SMS to hospital for duty ${dutyId}:`, smsError);
        }
    },

    // Staff submits the Start OTP (read out by the hospital) along with their current
    // coordinates. Both the OTP and a fresh geofence check must pass to move 'enroute' ->
    // 'in-progress'. Wrong OTP or out-of-range counts toward the shared lockout counter.
    async verifyStartOtp(dutyId, userId, otp, sentLocation = null) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId).select('+startOtp.code').populate('hospital');
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
            throw new ForbiddenError('You can only verify OTP for duties assigned to you');
        }

        // Idempotency: already verified and moved to in-progress
        if (duty.status === 'in-progress' && duty.startOtp.status === 'VERIFIED') {
            return duty;
        }

        if (duty.status !== 'enroute') {
            throw new ValidationError('Duty must be enroute before verifying start OTP');
        }

        if (duty.startOtp.status === 'LOCKED') {
            throw new ForbiddenError('Start OTP is locked — contact admin support');
        }

        if (duty.startOtp.status !== 'PENDING' || !duty.startOtp.expiresAt || duty.startOtp.expiresAt <= getCurrentIST()) {
            if (duty.startOtp.status === 'PENDING') {
                await Duty.updateOne({ _id: dutyId }, { $set: { 'startOtp.status': 'EXPIRED' } });
            }
            throw new ValidationError('No active start OTP — move within range of the hospital to trigger one');
        }

        const hospitalLat = duty.hospital?.coordinates?.coordinates?.latitude;
        const hospitalLng = duty.hospital?.coordinates?.coordinates?.longitude;
        if (typeof hospitalLat !== 'number' || typeof hospitalLng !== 'number') {
            throw new ValidationError('Hospital location is not configured — contact support');
        }

        const staffLocation = await resolveStaffLocation(userId, sentLocation);
        if (!staffLocation) {
            throw new ValidationError('Unable to determine your current location. Ensure the app is online and sharing live GPS to the server.');
        }

        const geofenceOk = isWithinGeofence(staffLocation.latitude, staffLocation.longitude, hospitalLat, hospitalLng);
        const otpOk = duty.startOtp.code === otp;

        if (!geofenceOk || !otpOk) {
            const attempts = duty.startOtp.attempts + 1;
            const maxAttempts = parseInt(process.env.DUTY_OTP_MAX_ATTEMPTS) || 5;
            const updateFields = { 'startOtp.attempts': attempts };
            if (attempts >= maxAttempts) {
                updateFields['startOtp.status'] = 'LOCKED';
            }
            await Duty.updateOne({ _id: dutyId }, { $set: updateFields });

            const reasons = [];
            if (!otpOk) reasons.push('incorrect OTP');
            if (!geofenceOk) reasons.push('you are not within range of the hospital');

            if (attempts >= maxAttempts) {
                throw new ForbiddenError(`Verification failed (${reasons.join(' and ')}). Start OTP is now locked — contact admin support.`);
            }
            throw new ValidationError(`Verification failed: ${reasons.join(' and ')}. ${maxAttempts - attempts} attempt(s) remaining.`);
        }

        const now = getCurrentIST();
        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: 'enroute' },
            {
                $set: {
                    status: 'in-progress',
                    startedAt: now,
                    'startOtp.status': 'VERIFIED'
                },
                $push: {
                    statusHistory: {
                        status: 'in-progress',
                        timestamp: now,
                        changedBy: medicalStaff._id,
                        reason: 'Start OTP verified — duty started'
                    }
                }
            },
            { new: true }
        )
            .populate({
                path: 'hospital',
                populate: { path: 'user', select: 'name email' }
            })
            .populate({
                path: 'assignedTo',
                populate: { path: 'user', select: 'name email' }
            });

        if (!updated) {
            throw new ConflictError('Duty status changed before verification could complete — please retry');
        }

        return updated;
    },

    // Staff requests an End OTP once the duty is in-progress and the scheduled end time has
    // arrived. The code is sent via SMS to the staff's own registered phone number (never
    // returned in the response) and read out to the hospital, who enters it via verifyEndOtp.
    async requestEndOtp(dutyId, userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId).select('+endOtp.code');
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
            throw new ForbiddenError('You can only request an end OTP for duties assigned to you');
        }

        // Idempotency: an active OTP already exists — resend the same code via SMS
        if (duty.status === 'in-progress' && duty.endOtp.status === 'PENDING' && duty.endOtp.expiresAt > getCurrentIST()) {
            await this._sendStaffOtpSms(medicalStaff, duty.endOtp.code, dutyId, 'end');
            return { expiresAt: duty.endOtp.expiresAt };
        }

        if (duty.endOtp.status === 'LOCKED') {
            throw new ForbiddenError('End OTP is locked — contact admin support');
        }

        const validation = duty.canRequestEndOtp();
        if (!validation.allowed) {
            throw new ValidationError(validation.reason);
        }

        const code = OTPService.generateOTP();
        const expiryMinutes = parseInt(process.env.DUTY_END_OTP_EXPIRY_MINUTES) || 30;
        const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
        const now = getCurrentIST();

        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: 'in-progress' },
            {
                $set: {
                    'endOtp.code': code,
                    'endOtp.expiresAt': expiresAt,
                    'endOtp.attempts': 0,
                    'endOtp.status': 'PENDING',
                    'endOtp.sentAt': now
                }
            },
            { new: true }
        );

        if (!updated) {
            throw new ConflictError('Duty status changed — cannot request end OTP');
        }

        await this._sendStaffOtpSms(medicalStaff, code, dutyId, 'end');

        return { expiresAt: updated.endOtp.expiresAt };
    },

    // Hospital enters the End OTP (read out by the staff) along with a payment attestation
    // (method + paid/unpaid). Moves 'in-progress'/'pending-confirmation' -> 'completed'.
    async verifyEndOtp(dutyId, hospitalUserId, otp, paymentMethod, isPaid) {
        const hospital = await Hospital.findOne({ user: hospitalUserId });
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId).select('+endOtp.code').populate('hospital');
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (duty.hospital._id.toString() !== hospital._id.toString()) {
            throw new ForbiddenError('You can only verify OTP for your own duties');
        }

        // Idempotency: already completed via end OTP
        if (duty.status === 'completed' && duty.endOtp.status === 'VERIFIED') {
            return Duty.findById(dutyId)
                .populate({ path: 'hospital', populate: { path: 'user', select: 'name email' } })
                .populate({ path: 'assignedTo', populate: { path: 'user', select: 'name email' } });
        }

        const validation = duty.canVerifyEndOtp();
        if (!validation.allowed) {
            if (duty.endOtp.status === 'LOCKED') {
                throw new ForbiddenError(validation.reason);
            }
            if (duty.endOtp.status === 'PENDING' && (!duty.endOtp.expiresAt || duty.endOtp.expiresAt <= getCurrentIST())) {
                await Duty.updateOne({ _id: dutyId }, { $set: { 'endOtp.status': 'EXPIRED' } });
            }
            throw new ValidationError(validation.reason);
        }

        const otpOk = duty.endOtp.code === otp;

        if (!otpOk) {
            const attempts = duty.endOtp.attempts + 1;
            const maxAttempts = parseInt(process.env.DUTY_OTP_MAX_ATTEMPTS) || 5;
            const updateFields = { 'endOtp.attempts': attempts };
            if (attempts >= maxAttempts) {
                updateFields['endOtp.status'] = 'LOCKED';
            }
            await Duty.updateOne({ _id: dutyId }, { $set: updateFields });

            if (attempts >= maxAttempts) {
                throw new ForbiddenError('Incorrect OTP. End OTP is now locked — contact admin support.');
            }
            throw new ValidationError(`Incorrect OTP. ${maxAttempts - attempts} attempt(s) remaining.`);
        }

        const now = getCurrentIST();
        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: { $in: ['in-progress', 'pending-confirmation'] } },
            {
                $set: {
                    status: 'completed',
                    completedAt: now,
                    paymentMethod,
                    isPaid,
                    paymentAttestedAt: now,
                    paymentAttestedBy: hospitalUserId,
                    'endOtp.status': 'VERIFIED'
                },
                $push: {
                    statusHistory: {
                        status: 'completed',
                        timestamp: now,
                        changedBy: hospitalUserId,
                        reason: 'End OTP verified by hospital — duty completed'
                    }
                }
            },
            { new: true }
        )
            .populate({
                path: 'hospital',
                populate: { path: 'user', select: 'name email' }
            })
            .populate({
                path: 'assignedTo',
                populate: { path: 'user', select: 'name email' }
            });

        if (!updated) {
            throw new ConflictError('Duty status changed before verification could complete — please retry');
        }

        return updated;
    },

    async resendOtp(dutyId, userId, userRole, otpType) {
        if (userRole !== 'staff') {
            throw new ForbiddenError('Only the assigned staff member can resend duty OTPs');
        }

        if (otpType === 'start') {
            // Reuses requestStartOtp's window/geofence checks, minting, and SMS dispatch verbatim
            return this.requestStartOtp(dutyId, userId);
        }
        if (otpType === 'end') {
            return this._resendEndOtp(dutyId, userId);
        }
        throw new ValidationError("otpType must be 'start' or 'end'");
    },

    async _resendEndOtp(dutyId, userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new NotFoundError('Medical staff profile not found. Please complete your profile first.');
        }

        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (!duty.assignedTo || duty.assignedTo.toString() !== medicalStaff._id.toString()) {
            throw new ForbiddenError('You can only resend OTP for duties assigned to you');
        }

        if (!['in-progress', 'pending-confirmation'].includes(duty.status)) {
            throw new ValidationError('End OTP can only be resent while the duty is in progress or pending confirmation');
        }

        if (duty.endOtp.status === 'LOCKED') {
            throw new ForbiddenError('End OTP is locked — contact admin support');
        }

        const code = OTPService.generateOTP();
        const expiryMinutes = parseInt(process.env.DUTY_END_OTP_EXPIRY_MINUTES) || 30;
        const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
        const now = getCurrentIST();

        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, status: { $in: ['in-progress', 'pending-confirmation'] } },
            {
                $set: {
                    'endOtp.code': code,
                    'endOtp.expiresAt': expiresAt,
                    'endOtp.attempts': 0,
                    'endOtp.status': 'PENDING',
                    'endOtp.sentAt': now
                }
            },
            { new: true }
        ).populate({
            path: 'assignedTo',
            populate: { path: 'user', select: 'name email' }
        });

        if (!updated) {
            throw new ConflictError('Duty status changed — cannot resend end OTP');
        }

        // The new code is only ever sent via SMS to staff's own phone — they read it out to the hospital
        await this._sendStaffOtpSms(updated.assignedTo, code, dutyId, 'end');

        // Notify staff in-app that a fresh OTP was sent (without exposing the code)
        if (updated.assignedTo?.user?._id) {
            notificationEmitter.emitEndOtpRegenerated(
                updated,
                updated.assignedTo.user._id.toString(),
                expiresAt
            ).catch(err => console.error(`Error sending end OTP regenerated notification for duty ${dutyId}:`, err));
        }

        return { expiresAt: updated.endOtp.expiresAt };
    }
};
