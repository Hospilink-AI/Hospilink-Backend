const cron = require('node-cron');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { markJobsInactive, cleanOldJobs } = require('./storage');
const automatedAgent = require('./automated_agent');

let scheduledTasks = [];
let findJobsFunction = null;

async function runLifecycleTasks() {
    logger.info('Running lifecycle management tasks...');

    try {
        const [inactiveCount, cleanedCount] = await Promise.all([
            markJobsInactive(config.inactiveDays || 7),
            cleanOldJobs(config.jobAgent?.dataRetentionDays || 7)
        ]);

        logger.info('Lifecycle tasks completed', {
            jobsMarkedInactive: inactiveCount,
            jobsCleaned: cleanedCount
        });

        return { inactiveCount, cleanedCount };
    } catch (error) {
        logger.error('Lifecycle tasks failed', { error: error.message });
        return { error: error.message };
    }
}

function setFindJobsFunction(fn) {
    findJobsFunction = fn;
}

function startScheduler(role, location, cronExpression = '0 9 * * *') {
    logger.info(`Starting scheduler`, { cronExpression });

    if (!cron.validate(cronExpression)) {
        throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    let automatedTask = null;
    
    // Start automated agent if enabled
    if (config.jobAgent?.enabled) {
        automatedTask = cron.schedule(config.jobAgent.scheduleInterval, async () => {
            logger.info('Running automated job agent...');
            await automatedAgent.runAutomatedSearches();
        });
        scheduledTasks.push(automatedTask);
        logger.info('Automated job agent scheduler active', {
            schedule: config.jobAgent.scheduleInterval
        });
    }

    // Daily cleanup task
    const lifecycleTask = cron.schedule('0 3 * * *', runLifecycleTasks);
    scheduledTasks.push(lifecycleTask);
    logger.info('Lifecycle scheduler active (runs daily at 3 AM)');

    // Run initial lifecycle task
    runLifecycleTasks().catch(err => {
        logger.warn('Initial lifecycle task failed', { error: err.message });
    });

    logger.info('Scheduler active. Waiting for next run...');

    return {
        automatedTask: automatedTask,
        lifecycleTask
    };
}

function stopScheduler() {
    for (const task of scheduledTasks) {
        task.stop();
    }
    scheduledTasks = [];
    logger.info('Scheduler stopped');
}

function getSchedulerStatus() {
    return {
        active: scheduledTasks.length > 0,
        taskCount: scheduledTasks.length,
        automatedAgent: automatedAgent.getStatus()
    };
}

module.exports = {
    startScheduler,
    stopScheduler,
    runLifecycleTasks,
    setFindJobsFunction,
    getSchedulerStatus
};