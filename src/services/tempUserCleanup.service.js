const TempUser = require('../models/TempUser');
const logger = require('../utils/logger');

class TempUserCleanupService {
    // Clean up expired temp users
    static async cleanupExpiredTempUsers() {
        try {
            const result = await TempUser.deleteMany({
                'otp.expiresAt': { $lt: new Date() }
            });
            
            logger.info(`Cleaned up ${result.deletedCount} expired temp users`);
            return result.deletedCount;
        } catch (error) {
            logger.error(`Error cleaning up temp users: ${error.message}`);
            return 0;
        }
    }

    // Clean up old temp users (older than specified hours)
    static async cleanupOldTempUsers(hoursOld = 24) {
        try {
            const cutoffDate = new Date();
            cutoffDate.setHours(cutoffDate.getHours() - hoursOld);
            
            const result = await TempUser.deleteMany({
                createdAt: { $lt: cutoffDate }
            });
            
            logger.info(`Cleaned up ${result.deletedCount} temp users older than ${hoursOld} hours`);
            return result.deletedCount;
        } catch (error) {
            logger.error(`Error cleaning up old temp users: ${error.message}`);
            return 0;
        }
    }
}

module.exports = TempUserCleanupService;