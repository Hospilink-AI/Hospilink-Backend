const DelayedJob = require('../models/DelayedJob');
const notificationEmitter = require('../services/notificationEmitter');

class JobProcessor {

    async process() {
        const now = new Date();

        const jobs = await DelayedJob.find({
            status: 'pending',
            processed: false,
            executeAt: { $lte: now }
        }).limit(20);

        for (const job of jobs) {
            try {
                job.status = 'processing';
                job.attempts += 1;
                await job.save();
                if (job.type === 'DUTY_EXPIRING') {
                    await this.handleDutyExpiring(job);
                }

                job.status = 'completed';
                job.processed = true;
                await job.save();

            } catch (error) {
                job.status = 'failed';
                job.lastError = error.message;
                if (job.attempts >= 3) {
                    job.status = 'failed';
                } else {
                    job.status = 'pending'; 
                }
                await job.save();
            }
        }
    }

}

module.exports = new JobProcessor();