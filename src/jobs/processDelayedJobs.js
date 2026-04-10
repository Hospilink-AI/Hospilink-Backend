const DelayedJob = require('../models/DelayedJob');
const notificationEmitter = require('../services/notificationEmitter');
const Duty = require('../models/Duty');

class JobProcessor {

    async process() {
        const now = new Date();

        const jobs = await DelayedJob.find({
            status: 'pending',
            executeAt: { $lte: now }
        }).limit(20);

        for (const job of jobs) {
            try {
                job.status = 'processing';
                job.attempts += 1;
                await job.save();

                if (job.type === 'RATE_SHIFT') {
                    await this.handleRateShift(job);
                }
                if (job.type === 'DUTY_EXPIRING') {
                    await this.handleDutyExpiring(job);
                }

                job.status = 'completed';
                await job.save();

            } catch (error) {
                job.status = 'failed';
                job.lastError = error.message;
                await job.save();
            }
        }
    }

    async handleRateShift(job) {
        const { dutyId, hospitalUserId, staffName } = job.payload;

        const duty = await Duty.findById(dutyId);
        if (!duty) return;

        const message = `How was your shift with ${staffName}? Rate your experience to help improve future matches.`;

        const payload = {
            type: 'RATE_SHIFT',
            priority: 'LOW',
            duty: { id: dutyId },
            message,
            timestamp: new Date().toISOString()
        };

        await notificationEmitter.emitRateShiftNotification(
            hospitalUserId,
            payload
        );
    }
    async handleDutyExpiring(job) {
        const { dutyId, staffRole, hospitalName, matchingStaffUserIds } = job.payload;

        // 🔒 Safety check
        const duty = await Duty.findById(dutyId);
        if (!duty || duty.status !== 'available') {
            return; //  Do not notify if already accepted/expired
        }

        if (!matchingStaffUserIds || matchingStaffUserIds.length === 0) return;

        const message = `Duty offer expiring in 5 minutes — ${staffRole} at ${hospitalName}. Accept now before it goes to the next candidate.`;

        const payload = {
            type: 'DUTY_EXPIRING',
            priority: 'NORMAL',
            duty: {
                id: dutyId,
                staffRole
            },
            hospital: {
                name: hospitalName
            },
            message,
            timestamp: new Date().toISOString()
        };

        const notificationService = require('../services/notificationService');
        const websocketManager = require('../services/websocketManager');

        //  Save notifications
        await notificationService.createBulkNotifications(
            matchingStaffUserIds,
            'DUTY_EXPIRING',
            payload
        );

        //  Send unread count
        const unreadCounts = await notificationService.getBulkUnreadCounts(matchingStaffUserIds);

        for (const userId of matchingStaffUserIds) {
            websocketManager.sendUnreadCount(userId, unreadCounts[userId] || 0);
        }

        // Real-time emit
        websocketManager.emitToUsers(matchingStaffUserIds, 'notification', payload);
    }
}

module.exports = new JobProcessor();