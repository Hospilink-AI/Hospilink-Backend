const DutyService = require('../services/duty.service');
const TempUserCleanupService = require('../services/tempUserCleanup.service');

class CronJobs {
    static startAllJobs() {
        // Run every 60 seconds (less resource intensive)
        setInterval(async () => {
            try {
                const completed = await DutyService.autoCompleteDuties();
                const expired = await DutyService.expireUnacceptedDuties();
                
                if (completed > 0) {
                    console.log(`Auto-completed ${completed} duties at ${new Date().toLocaleString()}`);
                }
                if (expired > 0) {
                    console.log(`Auto-expired ${expired} duties at ${new Date().toLocaleString()}`);
                }
            } catch (error) {
                console.error('Auto-processing error:', error);
            }
        }, 60000); // 60 seconds = 1 minute
        
        
        // TempUser cleanup job - run every 30 minutes
        setInterval(async () => {
            try {
                const deleted = await TempUserCleanupService.cleanupExpiredTempUsers();
                if (deleted > 0) {
                    console.log(`Cleaned up ${deleted} expired temp users at ${new Date().toLocaleString()}`);
                }
            } catch (error) {
                console.error('TempUser cleanup error:', error);
            }
        }, 30 * 60 * 1000); // 30 minutes
        
        console.log('Auto-complete job started (runs every minute)');
        console.log('TempUser cleanup job started (runs every 30 minutes)');
    }
}

module.exports = CronJobs;