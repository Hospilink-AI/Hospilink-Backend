const DutyService = require('../services/duty.service');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('./activityLog.constants');
const User = require('../models/User');
const notificationEmitter = require('../services/notificationEmitter');
const EmailService = require('../services/email.service');
const redisClient = require('../config/redis');
const InterviewLifecycleService = require('../services/interviewLifecycle.service');
const TicketService = require('../services/ticket.service');

/**
 * Acquire a distributed Redis lock so only one ECS task runs a given cron job.
 * Returns true if lock was acquired, false if another task already holds it.
 */
async function acquireCronLock(lockName, ttlSeconds) {
    try {
        const redis = await redisClient.getClientAsync();
        const result = await redis.set(
            `cron:lock:${lockName}`,
            process.env.HOSTNAME || 'local',
            'NX',
            'EX',
            ttlSeconds
        );
        return result === 'OK';
    } catch (err) {
        // If Redis is unavailable, allow the job to run (single-instance fallback)
        console.warn(`Could not acquire cron lock for ${lockName}, running anyway:`, err.message);
        return true;
    }
}

/**
 * Notify all admin users about an emergency/escalated duty via push + email.
 */
async function notifyAdminsForEmergency(duty, hospital, reason) {
    try {
        const admins = await User.find({ role: 'admin' }).select('_id name email');
        if (!admins.length) return;

        const adminIds = admins.map(a => a._id.toString());

        // Push notification to all admins
        await notificationEmitter.emitEmergencyAdminAlert(duty, hospital, adminIds, reason);

        // Email only to the configured alert address
        const alertEmail = process.env.ADMIN_LOGIN_ALERT_EMAIL;
        if (alertEmail) {
            EmailService.sendEmergencyAdminAlertEmail(alertEmail, 'Admin', duty, hospital, reason)
                .catch(err => console.error(`Error sending emergency alert email:`, err));
        }

        // Activity log
        activityLogEmitter.emitSystemActivity(
            ACTIVITY_ACTIONS.EMERGENCY_DUTY_ADMIN_NOTIFIED,
            { dutyId: duty._id?.toString(), reason, adminCount: admins.length, timestamp: new Date().toISOString() }
        ).catch(err => console.error('Error logging emergency admin notification:', err));
    } catch (err) {
        console.error('Error in notifyAdminsForEmergency:', err);
    }
}

class CronJobs {
    // calculate milliseconds until next scheduled time
    static getMillisecondsUntilNext(intervalMinutes) {
        const now = new Date();
        const minutes = now.getMinutes();
        const seconds = now.getSeconds();
        const milliseconds = now.getMilliseconds();

        // Calculate next scheduled minute (0, 30 for 30-min interval; 0, 15, 30, 45 for 15-min, etc.)
        const nextScheduledMinute = Math.ceil(minutes / intervalMinutes) * intervalMinutes;

        // Calculate time until next scheduled minute
        let minutesUntilNext = (nextScheduledMinute - minutes) % 60;

        // If we're exactly on the scheduled minute, wait for the full interval
        if (minutesUntilNext === 0 && seconds === 0 && milliseconds < 100) {
            minutesUntilNext = intervalMinutes;
        }

        const msUntilNext = (minutesUntilNext * 60 * 1000) - (seconds * 1000) - milliseconds;

        // Ensure we never return a negative or very small value
        return msUntilNext > 1000 ? msUntilNext : intervalMinutes * 60 * 1000;
    }


    // schedule a job to run at specific intervals on the clock
    static scheduleJob(jobFunction, intervalMinutes, jobName) {
        const runJob = async () => {
            try {
                await jobFunction();
            } catch (error) {
                console.error(`${jobName} error:`, error);
            }
        };

        // Calculate time until next scheduled run
        const msUntilNext = this.getMillisecondsUntilNext(intervalMinutes);
        const nextRunTime = new Date(Date.now() + msUntilNext);

        // Schedule first run at next scheduled time
        setTimeout(() => {
            runJob(); // Run immediately at scheduled time

            // Then run at regular intervals
            setInterval(runJob, intervalMinutes * 60 * 1000);
        }, msUntilNext);
    }

    static startAllJobs() {
        // Pending-confirmation job - run every 1 minute on the clock (:00, :01, :02, etc.)
        this.scheduleJob(
            async () => {
                // Distributed lock: 55s TTL — shorter than 60s interval so it always expires before next run
                const hasLock = await acquireCronLock('pending-confirmation', 55);
                if (!hasLock) return;

                const movedToPending = await DutyService.moveDutiesToPendingConfirmation();
                const expired = await DutyService.expireUnacceptedDuties();
                const reminders = DutyService.sendNavigationReminders ? await DutyService.sendNavigationReminders() : 0;
                const unassigned15 = DutyService.checkUnassigned15MinDuties ? await DutyService.checkUnassigned15MinDuties() : 0;
                const unfilledCritical = DutyService.checkUnfilledCriticalDuties ? await DutyService.checkUnfilledCriticalDuties() : 0;

                // Auto-escalate unassigned duties starting within 1 hour
                const { count: escalated, duties: escalatedDuties } = await DutyService.autoEscalateUnassignedDuties();
                if (escalated > 0) {
                    console.log(`Auto-escalated ${escalated} duties to CRITICAL at ${new Date().toLocaleString()}`);
                    activityLogEmitter.emitSystemActivity(
                        ACTIVITY_ACTIONS.DUTY_ESCALATED_TO_CRITICAL,
                        { dutiesEscalated: escalated, timestamp: new Date().toISOString() }
                    ).catch(err => console.error('Error logging escalation:', err));

                    // Notify admins for each escalated duty
                    for (const duty of escalatedDuties) {
                        notifyAdminsForEmergency(duty, duty.hospital, 'escalated')
                            .catch(err => console.error('Error notifying admins for escalated duty:', err));
                    }
                }

                if (movedToPending > 0) {
                    console.log(`Moved ${movedToPending} duties to pending-confirmation at ${new Date().toLocaleString()}`);

                    // Log pending-confirmation activity
                    activityLogEmitter.emitSystemActivity(
                        ACTIVITY_ACTIONS.DUTY_PENDING_CONFIRMATION,
                        { dutiesMoved: movedToPending, timestamp: new Date().toISOString() }
                    ).catch(err => console.error('Error logging pending-confirmation:', err));
                }
                if (expired > 0) {
                    console.log(`Auto-expired ${expired} duties at ${new Date().toLocaleString()}`);

                    // Log duty expiration activity
                    activityLogEmitter.emitSystemActivity(
                        ACTIVITY_ACTIONS.DUTY_EXPIRED,
                        { dutiesExpired: expired, timestamp: new Date().toISOString() }
                    ).catch(err => console.error('Error logging duty expiration:', err));
                }
                if (reminders > 0) {
                    console.log(`Sent ${reminders} navigation reminders at ${new Date().toLocaleString()}`);
                }
                if (unassigned15 > 0) {
                    console.log(`Sent ${unassigned15} duty unassigned 15-min notifications`);
                }
                if (unfilledCritical > 0) {
                    console.log(`Sent ${unfilledCritical} duty unfilled critical notifications`);
                }
            },
            1,
            'Pending-confirmation job'
        );


        // Mark incomplete duties job - run every 30 minutes on the clock (:00 and :30)
        this.scheduleJob(
            async () => {
                // Distributed lock: 29 minutes TTL — shorter than 30min interval
                const hasLock = await acquireCronLock('mark-incomplete', 29 * 60);
                if (!hasLock) return;

                const markedIncomplete = await DutyService.markIncompleteDuties();
                if (markedIncomplete > 0) {
                    console.log(`Marked ${markedIncomplete} duties incomplete at ${new Date().toLocaleString()}`);

                    // Log mark incomplete activity
                    activityLogEmitter.emitSystemActivity(
                        ACTIVITY_ACTIONS.DUTY_MARKED_INCOMPLETE,
                        { dutiesMarked: markedIncomplete, timestamp: new Date().toISOString() }
                    ).catch(err => console.error('Error logging mark incomplete:', err));
                }
            },
            30,
            'Mark incomplete duties job'
        );

        // Interview lifecycle job — run every 15 minutes. Bundles all six
        // sweeps (offer/selection expiry, day-3/10/18 nudges, 24h/1h
        // interview reminders, both-absent 7-day lapse, hire close-out
        // prompts) into one tick, same "bundle several checks into one
        // scheduled run" pattern as the pending-confirmation job above.
        this.scheduleJob(
            async () => {
                // 14-min TTL — shorter than the 15-min interval so it always expires before the next run
                const hasLock = await acquireCronLock('interview-lifecycle', 14 * 60);
                if (!hasLock) return;

                const results = {
                    offerExpiry: await InterviewLifecycleService.sweepOfferExpiry(),
                    selectionExpiry: await InterviewLifecycleService.sweepSelectionExpiry(),
                    nudges: await InterviewLifecycleService.sweepNudges(),
                    reminders: await InterviewLifecycleService.sweepInterviewReminders(),
                    bothAbsentLapse: await InterviewLifecycleService.sweepBothAbsentLapse(),
                    hireCloseout: await InterviewLifecycleService.sweepHireCloseout()
                };

                const totalActions = Object.values(results).reduce((sum, n) => sum + n, 0);
                if (totalActions > 0) {
                    console.log(`Interview lifecycle job at ${new Date().toLocaleString()}:`, results);

                    activityLogEmitter.emitSystemActivity(
                        ACTIVITY_ACTIONS.CRON_JOB_EXECUTED,
                        { jobName: 'Interview lifecycle job', ...results, timestamp: new Date().toISOString() }
                    ).catch(err => console.error('Error logging interview lifecycle job:', err));
                }
            },
            15,
            'Interview lifecycle job'
        );

        // Ticket SLA sweeps job — run every 15 minutes. Bundles the
        // respondent-window reminders/lapse, the awaiting-raiser day-1/day-3
        // reminders + 5-day auto-close, and the priority-based claim-timeout
        // sweep into one tick, same "bundle several sweeps into one
        // scheduled run" pattern as the interview lifecycle job above. No
        // serverless (api/cron/) mirror yet — interview-lifecycle set the
        // precedent that a bundled sweep like this stays interval-only.
        this.scheduleJob(
            async () => {
                const hasLock = await acquireCronLock('ticket-sla-sweeps', 14 * 60);
                if (!hasLock) return;

                const results = {
                    respondentWindow: await TicketService.sweepRespondentWindow(),
                    awaitingRaiser: await TicketService.sweepAwaitingRaiser(),
                    claimTimeout: await TicketService.sweepClaimTimeout()
                };

                const totalActions = results.respondentWindow.remindersSent + results.respondentWindow.lapsed +
                    results.awaitingRaiser.remindersSent + results.awaitingRaiser.autoClosed +
                    results.claimTimeout.returned;

                if (totalActions > 0) {
                    console.log(`Ticket SLA sweeps job at ${new Date().toLocaleString()}:`, results);

                    activityLogEmitter.emitSystemActivity(
                        ACTIVITY_ACTIONS.CRON_JOB_EXECUTED,
                        { jobName: 'Ticket SLA sweeps job', ...results, timestamp: new Date().toISOString() }
                    ).catch(err => console.error('Error logging ticket SLA sweeps job:', err));
                }
            },
            15,
            'Ticket SLA sweeps job'
        );

        console.log('Cron jobs scheduled: Auto-complete (1 min), Mark incomplete (30 min), Interview lifecycle (15 min), Ticket SLA sweeps (15 min)');

        // Log cron job initialization after a short delay to ensure DB/Redis are ready
        setTimeout(() => {
            activityLogEmitter.emitSystemActivity(
                ACTIVITY_ACTIONS.CRON_JOB_EXECUTED,
                {
                    jobName: 'Cron Jobs Initialization',
                    jobs: ['Auto-complete', 'Mark incomplete'],
                    timestamp: new Date().toISOString()
                }
            ).catch(err => console.error('Error logging cron initialization:', err));
        }, 3000);
    }

}

module.exports = CronJobs;