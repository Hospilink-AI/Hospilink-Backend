const express = require('express');
const router = express.Router();
const jobProcessor = require('../jobs/processDelayedJobs');

// Secure endpoint (IMPORTANT)
router.get('/process-jobs', async (req, res) => {
    try {
        const secret = req.headers['x-cron-secret'];

        if (secret !== process.env.CRON_SECRET) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized cron access'
            });
        }

        await jobProcessor.process();

        res.status(200).json({
            success: true,
            message: 'Jobs processed successfully'
        });

    } catch (error) {
        console.error('Cron job error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;