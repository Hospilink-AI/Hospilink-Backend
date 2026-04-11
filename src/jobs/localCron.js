const cron = require('node-cron');
const jobProcessor = require('./processDelayedJobs');

const startLocalCron = () => {
    console.log(' Local cron started (every 1 minute)');

    cron.schedule('* * * * *', async () => {
        try {
            await jobProcessor.process();
        } catch (error) {
            console.error(' Cron failed:', error.message);
        }
    });
};

module.exports = startLocalCron;