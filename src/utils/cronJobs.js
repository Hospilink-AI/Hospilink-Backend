const DutyService = require('../services/duty.service');
const TempUserCleanupService = require('../services/tempUserCleanup.service');

class CronJobs {
    /**
     * Calculate milliseconds until next scheduled time
     * @param {number} intervalMinutes - Interval in minutes (e.g., 30 for every 30 minutes)
     * @returns {number} Milliseconds until next scheduled time
     */
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

    /**
     * Schedule a job to run at specific intervals on the clock
     * @param {Function} jobFunction - The function to execute
     * @param {number} intervalMinutes - Interval in minutes
     * @param {string} jobName - Name of the job for logging
     */
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
                const completed = await DutyService.autoCompleteDuties();
                const expired = await DutyService.expireUnacceptedDuties();
                const reminders = await DutyService.sendNavigationReminders();
                
                if (completed > 0) {
                    console.log(`Auto-completed ${completed} duties at ${new Date().toLocaleString()}`);
                }
                if (expired > 0) {
                    console.log(`Auto-expired ${expired} duties at ${new Date().toLocaleString()}`);
                }
                if (reminders > 0) {
                    console.log(`Sent ${reminders} navigation reminders at ${new Date().toLocaleString()}`);
                }
            },
            1,
            'Auto-complete job'
        );
        
        // TempUser cleanup job - run every 30 minutes on the clock (:00 and :30)
        this.scheduleJob(
            async () => {
                const deleted = await TempUserCleanupService.cleanupExpiredTempUsers();
                if (deleted > 0) {
                    console.log(`Cleaned up ${deleted} expired temp users at ${new Date().toLocaleString()}`);
                }
            },
            30,
            'TempUser cleanup job'
        );

        // Mark incomplete duties job - run every 30 minutes on the clock (:00 and :30)
        this.scheduleJob(
            async () => {
                const markedIncomplete = await DutyService.markIncompleteDuties();
                if (markedIncomplete > 0) {
                    console.log(`Marked ${markedIncomplete} duties incomplete at ${new Date().toLocaleString()}`);
                }
            },
            30,
            'Mark incomplete duties job'
        );

        console.log('Cron jobs scheduled: Auto-complete (1 min), TempUser cleanup (30 min), Mark incomplete (30 min)');
    }
}

module.exports = CronJobs;