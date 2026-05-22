const connectDB = require('../../src/config/database');
const DutyService = require('../../src/services/duty.service');

module.exports = async (req, res) => {
    // Vercel Cron passes an Authorization header with CRON_SECRET
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await connectDB();

        const completed = await DutyService.autoCompleteDuties();
        const expired = await DutyService.expireUnacceptedDuties();

        console.log(`Cron: completed=${completed}, expired=${expired}`);

        res.status(200).json({ success: true, completed, expired });
    } catch (error) {
        console.error('Cron auto-complete error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};
