const User = require('../models/User');
const Duty = require('../models/Duty');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const JobVacancy = require('../models/JobVacancy');
const JobApplication = require('../models/JobApplication');
const cancellationService = require('./cancellation.service');
const jobVacancyService = require('./jobVacancy.service');
const jobApplicationService = require('./jobApplication.service');
const notificationEmitter = require('./notificationEmitter');
const activityLogEmitter = require('./activityLogEmitter');
const cacheService = require('./cache.service');
const systemConfigService = require('./systemConfig.service');
const EmailService = require('./email.service');
const logger = require('../utils/logger');
const { getCurrentIST } = require('../utils/helpers');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const { ACTIVE_STATUSES: ACTIVE_APPLICATION_STATUSES } = require('../utils/jobApplication.constants');
const { UnauthorizedError, ForbiddenError, ConflictError } = require('../middleware/error.middleware');

const GRACE_DAYS = 7;
const REASON_TEXT = 'Account deleted';
const HOSPITAL_CANCEL_CUTOFF_MINUTES = 30;
// A duty already under way can't be cancelled out from under the other side
const UNDER_WAY = ['enroute', 'in-progress', 'pending-confirmation'];

class AccountDeletionService {
    async status(userId) {
        const user = await User.findById(userId).select('deletion').lean();
        const pending = !!(user?.deletion?.requestedAt && !user.deletion.completedAt);
        return {
            scheduled: pending,
            requestedAt: pending ? user.deletion.requestedAt : null,
            scheduledFor: pending ? user.deletion.scheduledFor : null,
            graceDays: GRACE_DAYS
        };
    }

    // Locks the account now and schedules the personal data for removal.
    // Upcoming duties are cancelled first, so a failure leaves the account usable.
    async request(userId, password, reason, req = null) {
        const user = await User.findById(userId).select('+password');
        if (!user || !['staff', 'hospital'].includes(user.role)) {
            throw new ForbiddenError('Only doctor and hospital accounts can be deleted here.');
        }
        if (user.deletion?.requestedAt) {
            throw new ConflictError('This account is already scheduled for deletion.');
        }
        if (!password || !(await user.comparePassword(password))) {
            throw new UnauthorizedError('Incorrect password.');
        }

        const isHospital = user.role === 'hospital';
        const profile = isHospital
            ? await Hospital.findOne({ user: user._id }).select('_id hospitalLegalName')
            : await MedicalStaff.findOne({ user: user._id }).select('_id fullName');

        let duties = [];
        if (profile) {
            duties = await Duty.find(isHospital
                ? { hospital: profile._id, status: { $in: ['available', 'assigned', ...UNDER_WAY] } }
                : { assignedTo: profile._id, status: { $in: ['assigned', ...UNDER_WAY] } }
            ).select('_id status date startTime staffRole');
            await this._assertNothingImminent(duties, isHospital);
        }

        const actor = { _id: user._id, name: profile?.fullName || profile?.hospitalLegalName || user.name, role: user.role };
        const cancelled = isHospital
            ? await this._cancelHospitalDuties(duties, actor)
            : await this._cancelStaffDuties(duties, actor);
        const recruitment = isHospital
            ? await this._closeVacancies(profile, actor)
            : await this._withdrawApplications(user._id);

        const now = new Date();
        const scheduledFor = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
        await User.updateOne(
            { _id: user._id },
            {
                $set: {
                    deletion: { requestedAt: now, scheduledFor, reason: reason ? String(reason).slice(0, 500) : undefined },
                    fcmTokens: []
                },
                $unset: { otp: 1 }
            }
        );
        await this._signOut(user, req);
        if (!isHospital) await this._hideStaff(user._id);

        EmailService.sendAccountDeletionScheduledEmail(user.email, actor.name, scheduledFor)
            .catch(err => logger.error(`Failed to send account deletion email: ${err.message}`));

        activityLogEmitter.emitUserActivity(
            ACTIVITY_ACTIONS.ACCOUNT_DELETION_REQUESTED,
            user,
            activityLogEmitter.actorFrom({ ...actor, email: user.email }),
            { scheduledFor, dutiesCancelled: cancelled, ...recruitment, reason: reason || null },
            req
        ).catch(() => {});

        return { scheduled: true, requestedAt: now, scheduledFor, graceDays: GRACE_DAYS, dutiesCancelled: cancelled, ...recruitment };
    }

    // Signing in during the grace period keeps the account
    async cancelOnSignin(user) {
        if (!user?.deletion?.requestedAt || user.deletion.completedAt) return false;
        const { modifiedCount } = await User.updateOne(
            { _id: user._id, 'deletion.completedAt': { $exists: false } },
            { $unset: { deletion: 1 } }
        );
        if (!modifiedCount) return false;
        activityLogEmitter.emitUserActivity(
            ACTIVITY_ACTIONS.ACCOUNT_DELETION_CANCELLED,
            user,
            activityLogEmitter.actorFrom(user),
            { requestedAt: user.deletion.requestedAt }
        ).catch(() => {});
        return true;
    }

    async _assertNothingImminent(duties, isHospital) {
        if (duties.some(d => UNDER_WAY.includes(d.status))) {
            throw new ConflictError(isHospital
                ? 'A duty at your hospital is under way. Your account can be deleted once it is finished.'
                : 'You have a duty under way. Finish it before deleting your account.');
        }
        const cutoff = isHospital
            ? HOSPITAL_CANCEL_CUTOFF_MINUTES
            : await systemConfigService.getEffective('autoRelist.staffCancelCutoffMinutes');
        const soon = duties.find(d => d.status === 'assigned' && cancellationService._getMinutesUntilDutyStart(d) < cutoff);
        if (soon) {
            throw new ConflictError(`You have a duty starting in less than ${cutoff} minutes. Your account can be deleted once it is finished.`);
        }
    }

    // Each duty goes back on offer through the normal staff-cancel path, and
    // the hospital is told
    async _cancelStaffDuties(duties, actor) {
        for (const { _id } of duties) {
            const duty = await cancellationService.cancelDuty(_id, actor, 'other_staff', REASON_TEXT, { skipWatchlist: true });
            this._logCancelled(duty, actor, 'other_staff');
            const hospitalUserId = duty.hospital?.user?._id;
            if (hospitalUserId) {
                notificationEmitter.emitDutyCancelled(duty, actor, 'other_staff', REASON_TEXT, [hospitalUserId.toString()])
                    .catch(() => {});
            }
        }
        return duties.length;
    }

    // Skips the 30-minute window for unfilled duties: nobody is waiting on them
    async _cancelHospitalDuties(duties, actor) {
        for (const { _id } of duties) {
            const duty = await Duty.findById(_id).populate({ path: 'assignedTo', select: 'user' });
            if (!duty || !['available', 'assigned'].includes(duty.status)) continue;
            const staffUserId = duty.status === 'assigned' ? duty.assignedTo?.user : null;
            const now = getCurrentIST();
            duty.status = 'cancelled';
            duty.cancellation = { cancelledBy: 'hospital', reason: 'other_hospital', reasonText: REASON_TEXT, timestamp: now };
            duty.statusHistory.push({ status: 'cancelled', timestamp: now, changedBy: actor._id, reason: REASON_TEXT });
            await duty.save();
            this._logCancelled(duty, actor, 'other_hospital');
            if (staffUserId) {
                notificationEmitter.emitDutyCancelled(duty, actor, 'other_hospital', REASON_TEXT, [staffUserId.toString()])
                    .catch(() => {});
            }
        }
        return duties.length;
    }

    _logCancelled(duty, actor, reason) {
        activityLogEmitter.emitDutyActivity(
            ACTIVITY_ACTIONS.DUTY_CANCELLED,
            duty,
            activityLogEmitter.actorFrom(actor),
            { reason, reasonText: REASON_TEXT, cancelledBy: actor.role, accountDeletion: true }
        ).catch(() => {});
    }

    async _closeVacancies(hospital, actor) {
        if (!hospital) return { vacanciesClosed: 0 };
        const open = await JobVacancy.find({ hospitalId: hospital._id, deletedAt: null });
        for (const vacancy of open) {
            vacancy.deletedAt = new Date();
            await vacancy.save();
            await jobVacancyService._closeOpenApplications(vacancy, actor);
        }
        return { vacanciesClosed: open.length };
    }

    async _withdrawApplications(userId) {
        const active = await JobApplication.find({ user: userId, status: { $in: ACTIVE_APPLICATION_STATUSES } }).select('_id');
        for (const { _id } of active) {
            await jobApplicationService.withdraw(_id, userId, 'other', REASON_TEXT);
        }
        return { applicationsWithdrawn: active.length };
    }

    async _signOut(user, req) {
        const token = req?.headers?.authorization?.split(' ')[1];
        await Promise.all([
            cacheService.del(`session:${user._id}`),
            cacheService.del(`user:${user.email}`),
            token ? require('./auth.service').logout(token, user._id).catch(() => {}) : null
        ]);
    }

    async _hideStaff(userId) {
        await MedicalStaff.updateOne({ user: userId }, { $set: { isAvailable: false } });
        await require('./dashboard.service').revokeDashboardLocationPermission(userId)
            .catch(err => logger.error(`Failed to clear live location on account deletion: ${err.message}`));
    }
}

module.exports = new AccountDeletionService();
