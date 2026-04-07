const connectDB = require('../../src/config/database');
const TempUserCleanupService = require('../../src/services/tempUserCleanup.service');

module.exports = async (req, res) => {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        await connectDB();

        const deleted = await TempUserCleanupService.cleanupExpiredTempUsers();

        console.log(`Cron: cleaned up ${deleted} expired temp users`);

        res.status(200).json({ success: true, deleted });
    } catch (error) {
        console.error('Cron cleanup error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};
