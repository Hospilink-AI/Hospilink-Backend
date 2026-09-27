const JobApplication = require('../models/JobApplication');
const systemConfigService = require('./systemConfig.service');
const notificationEmitter = require('./notificationEmitter');
const { ACTIVE_STATUSES } = require('../utils/jobApplication.constants');

const DAY_MS = 24 * 60 * 60 * 1000;
const NUDGE_LABELS = ['day3', 'day10', 'day18'];

// Six independent sweeps, called from one cron tick (utils/cronJobs.js) —
// same "bundle several checks into one scheduled run" pattern Duty's
// pending-confirmation job already uses. Every expiry here reverses exactly
// one step (back to shortlisted) rather than terminating the application,
// and every transition is written to statusHistory with changedBy: 'system'
// so the audit trail never looks hand-edited.
class InterviewLifecycleService {
    // slots_offered -> shortlisted, once interview.offer.expiresAt has passed.
    async sweepOfferExpiry() {
        const stale = await JobApplication.find({
            status: 'slots_offered',
            'interview.offer.expiresAt': { $lte: new Date() }
        });

        for (const application of stale) {
            application.status = 'shortlisted';
            application.interview.candidatePicks = undefined;
            application.pushHistory('shortlisted', 'system', 'Offer expired — candidate never picked a slot');
            await application.save();
            await notificationEmitter.emitOfferExpired(application);
        }
        return stale.length;
    }

    // slot_selected -> shortlisted, once the confirmation-expiry clock
    // (min(pickedAt + confirmationExpiryDays, last picked slot's start))
    // has passed. Not stored on the document — recomputed on each sweep
    // from pickedAt + the current picks, same "live over stored" approach
    // used throughout this module.
    async sweepSelectionExpiry() {
        const confirmationExpiryDays = await systemConfigService.getEffective('interview.confirmationExpiryDays');
        const now = Date.now();

        const candidates = await JobApplication.find({ status: 'slot_selected' });
        let expiredCount = 0;

        for (const application of candidates) {
            const picks = application.interview.candidatePicks || [];
            if (picks.length === 0 || !application.interview.pickedAt) continue;

            const lastPickStart = Math.max(...picks.map(p => p.start.getTime()));
            const maxExpiry = application.interview.pickedAt.getTime() + confirmationExpiryDays * DAY_MS;
            const expiresAt = Math.min(lastPickStart, maxExpiry);

            if (expiresAt > now) continue;

            application.status = 'shortlisted';
            application.interview.candidatePicks = undefined;
            application.pushHistory('shortlisted', 'system', 'Selection expired — hospital never confirmed in time');
            await application.save();
            await notificationEmitter.emitSelectionExpired(application);
            expiredCount++;
        }
        return expiredCount;
    }

    // Day 3/10/18 reminders for both stall clocks — offer (candidate hasn't
    // picked) and selection (hospital hasn't confirmed). Dedupe flags on the
    // document (nudgesSent / selectionNudgesSent) guarantee each boundary
    // fires at most once even if the sweep runs more often than once a day.
    async sweepNudges() {
        const nudgeDays = await systemConfigService.getEffective('interview.nudgeScheduleDays');
        let sentCount = 0;

        const offered = await JobApplication.find({ status: 'slots_offered' });
        for (const application of offered) {
            sentCount += await this._sendDueNudges(
                application,
                application.interview.offer?.offeredAt,
                nudgeDays,
                'interview.offer.nudgesSent',
                (label) => notificationEmitter.emitOfferUnansweredReminder(application, label)
            );
        }

        const selected = await JobApplication.find({ status: 'slot_selected' });
        for (const application of selected) {
            sentCount += await this._sendDueNudges(
                application,
                application.interview.pickedAt,
                nudgeDays,
                'interview.selectionNudgesSent',
                (label) => notificationEmitter.emitConfirmationPendingReminder(application, label)
            );
        }

        return sentCount;
    }

    async _sendDueNudges(application, clockStart, nudgeDays, nudgesPath, emit) {
        if (!clockStart) return 0;

        const nudgesSent = nudgesPath.split('.').reduce((obj, key) => obj?.[key], application);
        if (!nudgesSent) return 0;

        const elapsedDays = (Date.now() - new Date(clockStart).getTime()) / DAY_MS;
        let sent = 0;

        for (let i = 0; i < nudgeDays.length && i < NUDGE_LABELS.length; i++) {
            const label = NUDGE_LABELS[i];
            if (elapsedDays >= nudgeDays[i] && !nudgesSent[label]) {
                await emit(label);
                nudgesSent[label] = true;
                sent++;
            }
        }

        if (sent > 0) {
            application.markModified(nudgesPath);
            await application.save();
        }
        return sent;
    }

    // 24h and 1h reminders ahead of a confirmed interview's start time. The
    // 1h reminder is in-app/push only — emitInterviewReminder's caller
    // (notificationDelivery) handles the channel split, this sweep just
    // decides *when* to fire.
    async sweepInterviewReminders() {
        const now = Date.now();
        let sentCount = 0;

        sentCount += await this._sendWindowReminder(now, 24 * 60 * 60 * 1000, 'sent24h', '24h');
        sentCount += await this._sendWindowReminder(now, 60 * 60 * 1000, 'sent1h', '1h');

        return sentCount;
    }

    async _sendWindowReminder(now, windowMs, flagField, label) {
        const due = await JobApplication.find({
            status: 'confirmed',
            'interview.confirmedSlot.start': { $gte: new Date(now), $lte: new Date(now + windowMs) },
            [`interview.reminders.${flagField}`]: false
        });

        for (const application of due) {
            await notificationEmitter.emitInterviewReminder(application, label);
            application.interview.reminders[flagField] = true;
            application.markModified('interview.reminders');
            await application.save();
        }
        return due.length;
    }

    // confirmed -> interviewed (outcome: not_recorded), once the confirmed
    // interview's start time is more than outcomeRecordingWindowDays in the
    // past and nobody has recorded an outcome or marked a no-show. No
    // penalty to anyone — the recruiter can still record a real outcome
    // afterward (interviewed -> offered/rejected stays open).
    async sweepBothAbsentLapse() {
        const outcomeWindowDays = await systemConfigService.getEffective('interview.outcomeRecordingWindowDays');
        const cutoff = new Date(Date.now() - outcomeWindowDays * DAY_MS);

        const stale = await JobApplication.find({
            status: 'confirmed',
            'interview.confirmedSlot.start': { $lte: cutoff }
        });

        for (const application of stale) {
            application.status = 'interviewed';
            application.interview.outcome = { result: 'not_recorded', recordedAt: new Date(), recordedBy: 'system' };
            application.pushHistory('interviewed', 'system', 'Neither side recorded an outcome within the window');
            await application.save();
        }
        return stale.length;
    }

    // Nudges a hospital to close out the remaining live applications on a
    // vacancy once one candidate has been hired — first prompt after
    // hireCloseoutFirstPromptDays, repeating every hireCloseoutRepeatDays
    // after that, tracked per-application via closeoutNudge.lastSentAt so
    // each sibling application gets its own independent cadence.
    async sweepHireCloseout() {
        const [firstPromptDays, repeatDays] = await Promise.all([
            systemConfigService.getEffective('interview.hireCloseoutFirstPromptDays'),
            systemConfigService.getEffective('interview.hireCloseoutRepeatDays')
        ]);

        const hiredVacancyIds = await JobApplication.find({ status: 'hired' }).distinct('vacancy');
        if (hiredVacancyIds.length === 0) return 0;

        const now = Date.now();
        let vacanciesPrompted = 0;

        for (const vacancyId of hiredVacancyIds) {
            const hireDoc = await JobApplication.findOne({ vacancy: vacancyId, status: 'hired' })
                .sort({ updatedAt: -1 })
                .select('hospitalId updatedAt')
                .lean();
            if (!hireDoc) continue;

            const openApplications = await JobApplication.find({
                vacancy: vacancyId,
                status: { $in: ACTIVE_STATUSES }
            });
            if (openApplications.length === 0) continue;

            const dueApplications = openApplications.filter((app) => {
                const lastSent = app.closeoutNudge?.lastSentAt;
                const sinceMs = lastSent
                    ? now - new Date(lastSent).getTime()
                    : now - new Date(hireDoc.updatedAt).getTime();
                const thresholdDays = lastSent ? repeatDays : firstPromptDays;
                return sinceMs >= thresholdDays * DAY_MS;
            });
            if (dueApplications.length === 0) continue;

            for (const app of dueApplications) {
                app.closeoutNudge = { lastSentAt: new Date() };
                await app.save();
            }

            const hospital = await notificationEmitter._resolveHospitalUserId(hireDoc.hospitalId);
            if (hospital) {
                const vacancyTitle = await notificationEmitter._vacancyTitle(vacancyId);
                await notificationEmitter.emitHireCloseoutPrompt(hospital.userId, vacancyTitle, dueApplications.length);
            }
            vacanciesPrompted++;
        }

        return vacanciesPrompted;
    }
}

module.exports = new InterviewLifecycleService();
