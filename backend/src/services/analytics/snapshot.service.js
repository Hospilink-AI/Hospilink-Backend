const AnalyticsDailySnapshot = require('../../models/AnalyticsDailySnapshot');
const Duty = require('../../models/Duty');
const Hospital = require('../../models/Hospital');
const MedicalStaff = require('../../models/MedicalStaff');
const Ticket = require('../../models/Ticket');
const JobVacancy = require('../../models/JobVacancy');
const ActivityLog = require('../../models/ActivityLog');
const Notification = require('../../models/Notification');
const cacheService = require('../cache.service');
const logger = require('../../utils/logger');
const { ACTIVE_STATUSES: ACTIVE_TICKET_STATUSES } = require('../../utils/ticket.constants');
const { istDateKey, istDayRange, addDaysToKey } = require('../../utils/calendar.helper');
const { dutyHours } = require('../../utils/analytics.helper');

const METRICS_VERSION = 1;
const IN_FLIGHT_DUTY_STATUSES = ['assigned', 'enroute', 'in-progress', 'pending-confirmation'];

class AnalyticsSnapshotService {
    // Writes the row for one IST day. Stocks are counted now, so this is
    // only meant for the day that just ended.
    async writeSnapshot(dateKey) {
        const range = istDayRange(dateKey, dateKey);
        const todayStart = istDayRange(addDaysToKey(dateKey, 1), addDaysToKey(dateKey, 1)).$gte;

        const [
            hospitalsTotal, hospitalsVerified, hospitalsPending, hospitalsSuspended,
            staffTotal, staffVerified, staffPending, staffAvailable, staffSuspended,
            openDuties, inFlightDuties, ticketBacklog, liveVacancies,
            postedDuties, completedDuties, logins, notificationsSent, notificationsRead
        ] = await Promise.all([
            Hospital.countDocuments({}),
            Hospital.countDocuments({ verificationStatus: 'verified' }),
            Hospital.countDocuments({ verificationStatus: 'pending' }),
            Hospital.countDocuments({ isSuspended: true }),
            MedicalStaff.countDocuments({}),
            MedicalStaff.countDocuments({ verificationStatus: 'verified' }),
            MedicalStaff.countDocuments({ verificationStatus: 'pending' }),
            MedicalStaff.countDocuments({ verificationStatus: 'verified', isAvailable: true }),
            MedicalStaff.countDocuments({ isSuspended: true }),
            Duty.countDocuments({ status: 'available', date: { $gte: todayStart }, isDemo: { $ne: true } }),
            Duty.countDocuments({ status: { $in: IN_FLIGHT_DUTY_STATUSES }, isDemo: { $ne: true } }),
            Ticket.countDocuments({ status: { $in: ACTIVE_TICKET_STATUSES } }),
            JobVacancy.countDocuments({ deletedAt: null }),
            Duty.find({ createdAt: range, isDemo: { $ne: true } }).select('status assignedAt').lean(),
            Duty.find({ status: 'completed', completedAt: range, isDemo: { $ne: true } }).select('offeredRate totalPayment').lean(),
            ActivityLog.aggregate([
                { $match: { action: 'USER_LOGIN', timestamp: range } },
                { $group: { _id: { user: '$actor.userId', role: '$actor.role' } } },
                { $group: { _id: '$_id.role', users: { $sum: 1 } } }
            ]),
            Notification.countDocuments({ createdAt: range }),
            Notification.countDocuments({ createdAt: range, isRead: true })
        ]);

        const activeUsers = Object.fromEntries(logins.map(row => [row._id || 'unknown', row.users]));

        const snapshot = {
            date: dateKey,
            scope: 'platform',
            scopeKey: 'all',
            metricsVersion: METRICS_VERSION,
            stocks: {
                hospitals: { total: hospitalsTotal, verified: hospitalsVerified, pending: hospitalsPending, suspended: hospitalsSuspended },
                staff: { total: staffTotal, verified: staffVerified, pending: staffPending, available: staffAvailable, suspended: staffSuspended },
                openDuties,
                inFlightDuties,
                ticketBacklog,
                liveVacancies
            },
            flows: {
                dutiesPosted: postedDuties.length,
                dutiesFilledFromPosted: postedDuties.filter(d => d.assignedAt).length,
                dutiesCompleted: completedDuties.length,
                completedHours: completedDuties.reduce((total, d) => total + dutyHours(d), 0),
                gmvCompleted: completedDuties.reduce((total, d) => total + (d.totalPayment || 0), 0),
                activeUsers,
                notificationsSent,
                notificationsRead
            },
            computedAt: new Date()
        };

        await AnalyticsDailySnapshot.updateOne(
            { date: dateKey, scope: 'platform', scopeKey: 'all' },
            { $set: snapshot },
            { upsert: true }
        );

        return snapshot;
    }



    // Writes yesterday's row if it isn't there yet. Called by the hourly cron
    // and, since crons may be off on some deployments, from the analytics
    // read path too. Older missing days are not filled: their stocks can't
    // be counted after the fact.
    async ensureYesterday() {
        const yesterday = addDaysToKey(istDateKey(new Date()), -1);
        try {
            const exists = await AnalyticsDailySnapshot.exists({ date: yesterday, scope: 'platform', scopeKey: 'all' });
            if (exists) return false;

            const locked = await cacheService.acquireLock(`analytics:snapshot:${yesterday}`, 600);
            if (!locked) return false;

            await this.writeSnapshot(yesterday);
            return true;
        } catch (error) {
            logger.error('Error writing analytics snapshot:', error);
            return false;
        }
    }



    async getSnapshots(fromKey, toKey) {
        return AnalyticsDailySnapshot.find({ scope: 'platform', scopeKey: 'all', date: { $gte: fromKey, $lte: toKey } })
            .sort({ date: 1 })
            .lean();
    }
}

module.exports = new AnalyticsSnapshotService();
