const DutyService = require('../services/duty.service');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('./activityLog.constants');
const User = require('../models/User');
const notificationEmitter = require('../services/notificationEmitter');
const EmailService = require('../services/email.service');
const redisClient = require('../config/redis');

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
        // Auto-complete duties job - run every 1 minute on the clock (:00, :01, :02, etc.)
        this.scheduleJob(
            async () => {
                // Distributed lock: 55s TTL — shorter than 60s interval so it always expires before next run
                const hasLock = await acquireCronLock('auto-complete', 55);
                if (!hasLock) return;

                const movedToPending = await DutyService.autoCompleteDuties();
                const autoConfirmed = await DutyService.autoCompletePendingConfirmations();
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
                if (autoConfirmed > 0) {
                    console.log(`Auto-confirmed ${autoConfirmed} duties at ${new Date().toLocaleString()}`);

                    // Log auto-confirm activity
                    activityLogEmitter.emitSystemActivity(
                        ACTIVITY_ACTIONS.DUTY_AUTO_CONFIRMED,
                        { dutiesConfirmed: autoConfirmed, timestamp: new Date().toISOString() }
                    ).catch(err => console.error('Error logging auto-confirm:', err));
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
            'Auto-complete job'
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

        console.log('Cron jobs scheduled: Auto-complete (1 min), Mark incomplete (30 min)');

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