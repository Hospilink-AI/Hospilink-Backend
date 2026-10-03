const ActivityLog = require('../../models/ActivityLog');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const Document = require('../../models/Document');
const snapshotService = require('./snapshot.service');
const { splitByPeriod } = require('./dutyData');
const { istDateKey } = require('../../utils/calendar.helper');
const { tile, ratio, round, median, countBy, sum, bucketsBetween } = require('../../utils/analytics.helper');

const DAY_MS = 24 * 60 * 60 * 1000;
// Activity logs and notifications are deleted after this many days
const LOG_RETENTION_DAYS = 90;
const PENDING_DOCUMENT_STATUSES = ['pending', 'manual-pending-verification'];

const hoursBetween = (from, to) => (new Date(to) - new Date(from)) / 3600000;

class EngagementAnalytics {
    async build(period) {
        const now = new Date();
        const logStart = new Date(Math.max(period.compareStart.getTime(), now.getTime() - LOG_RETENTION_DAYS * DAY_MS));
        const monthStart = new Date(period.end.getTime() - 30 * DAY_MS);

        const [logins, failedLogins, securityEvents, notifications, seenRecently, pushPlatforms, documents, snapshots] = await Promise.all([
            ActivityLog.find({ action: 'USER_LOGIN', timestamp: { $gte: new Date(Math.min(logStart, monthStart)), $lt: period.end } })
                .select('timestamp actor.userId actor.role').lean(),
            ActivityLog.find({ action: 'USER_LOGIN_FAILED', timestamp: { $gte: logStart, $lt: period.end } }).select('timestamp').lean(),
            ActivityLog.find({ category: 'SECURITY', timestamp: { $gte: logStart, $lt: period.end } }).select('timestamp action').lean(),
            Notification.aggregate([
                { $match: { createdAt: { $gte: period.start, $lt: period.end } } },
                { $group: { _id: '$type', sent: { $sum: 1 }, read: { $sum: { $cond: ['$isRead', 1, 0] } } } }
            ]),
            User.aggregate([
                { $match: { lastActiveAt: { $gte: new Date(now.getTime() - 30 * DAY_MS) } } },
                { $group: { _id: '$role', users: { $sum: 1 } } }
            ]),
            User.aggregate([
                { $unwind: '$fcmTokens' },
                { $group: { _id: { user: '$_id', platform: '$fcmTokens.platform' } } },
                { $group: { _id: '$_id.platform', users: { $sum: 1 } } }
            ]),
            Document.find({}).select('userRole documents.documentType documents.verificationStatus documents.uploadedAt documents.verifiedAt documents.isDeleted').lean(),
            snapshotService.getSnapshots(period.compareFrom, period.to)
        ]);

        const dailyActive = this._dailyActive(logins, snapshots, period);
        const inPeriod = dailyActive.filter(d => d.date >= period.from);
        const beforePeriod = dailyActive.filter(d => d.date < period.from);
        const average = (rows) => (rows.filter(r => r.users !== null).length
            ? round(sum(rows.map(r => r.users || 0)) / rows.filter(r => r.users !== null).length, 1)
            : null);

        const monthLogins = logins.filter(l => l.timestamp >= monthStart);
        const weekLogins = logins.filter(l => l.timestamp >= new Date(period.end.getTime() - 7 * DAY_MS));
        const mau = new Set(monthLogins.map(l => String(l.actor?.userId))).size;
        const wau = new Set(weekLogins.map(l => String(l.actor?.userId))).size;
        const lastMonthDaily = dailyActive.filter(d => d.date >= istDateKey(monthStart));

        const failedSplit = splitByPeriod(failedLogins, l => l.timestamp, period);
        const securitySplit = splitByPeriod(securityEvents, l => l.timestamp, period);
        const docs = this._documents(documents, period);
        const notificationRows = notifications
            .map(n => ({ type: n._id, sent: n.sent, read: n.read, readRate: ratio(n.read, n.sent) }))
            .sort((a, b) => b.sent - a.sent);

        const tiles = [
            tile('dau', 'Average daily active users', average(inPeriod), average(beforePeriod), 'count'),
            tile('wau', 'Weekly active users (last 7 days of the period)', wau, null, 'count'),
            tile('mau', 'Monthly active users (last 30 days of the period)', mau, null, 'count'),
            tile('stickiness', 'Stickiness (daily ÷ monthly active)', ratio(average(lastMonthDaily), mau), null, 'ratio'),
            tile('seenLast30Days', 'Users seen in the last 30 days', sum(seenRecently.map(r => r.users)), null, 'count'),
            tile('notificationReadRate', 'Notifications opened', ratio(sum(notificationRows.map(n => n.read)), sum(notificationRows.map(n => n.sent))), null, 'ratio'),
            tile('failedLogins', 'Failed sign-ins', failedSplit.current.length, failedSplit.previous.length, 'count'),
            tile('securityEvents', 'Security events', securitySplit.current.length, securitySplit.previous.length, 'count'),
            tile('documentsVerified', 'Documents verified', docs.current.verified, docs.previous.verified, 'count'),
            tile('documentAutoVerifyRate', 'Documents verified automatically', docs.current.autoVerifiedShare, docs.previous.autoVerifiedShare, 'ratio'),
            tile('documentVerifyTime', 'Median upload to verification', docs.current.medianHoursToVerify, docs.previous.medianHoursToVerify, 'hours'),
            tile('documentBacklog', 'Documents waiting for review now', docs.backlog, null, 'count')
        ];

        const charts = [
            { key: 'dailyActive', type: 'line', title: 'Daily active users', series: inPeriod.map(d => ({ bucket: d.date, users: d.users })) },
            { key: 'activeByRole', type: 'donut', title: 'Active users by role (last 30 days of the period)', rows: this._activeByRole(monthLogins) },
            { key: 'seenByRole', type: 'donut', title: 'Users seen in the last 30 days, by role', rows: seenRecently.map(r => ({ key: r._id, count: r.users })) },
            { key: 'pushPlatforms', type: 'donut', title: 'Users with push enabled, by platform', rows: pushPlatforms.map(r => ({ key: r._id, count: r.users })) },
            { key: 'notificationsByType', type: 'table', title: 'Notifications by type', rows: notificationRows },
            { key: 'securityByAction', type: 'table', title: 'Security events by type', rows: countBy(securitySplit.current, e => e.action) },
            { key: 'documentsByType', type: 'table', title: 'Documents uploaded in the period, by type', rows: docs.byType }
        ];

        const dataNotes = [];
        if (period.compareStart < new Date(now.getTime() - LOG_RETENTION_DAYS * DAY_MS)) {
            dataNotes.push(`Sign-in and notification logs are kept for ${LOG_RETENTION_DAYS} days. Older daily active users come from the daily snapshot where it exists.`);
        }
        dataNotes.push('Users seen in the last 30 days uses the new last sign-in date, which fills in as people sign in.');

        return { tiles, charts, dataNotes };
    }



    // Distinct users signing in per day; days whose logs have expired fall
    // back to the daily snapshot
    _dailyActive(logins, snapshots, period) {
        const byDay = new Map();
        for (const login of logins) {
            const day = istDateKey(login.timestamp);
            if (!byDay.has(day)) byDay.set(day, new Set());
            byDay.get(day).add(String(login.actor?.userId));
        }
        const snapshotByDay = new Map(snapshots.map(s => [s.date, s]));
        const oldestLogDay = istDateKey(new Date(Date.now() - LOG_RETENTION_DAYS * DAY_MS));

        return bucketsBetween(period.compareFrom, period.to, 'day').map(date => {
            if (date >= oldestLogDay) return { date, users: byDay.get(date)?.size || 0 };
            const snap = snapshotByDay.get(date);
            return { date, users: snap ? sum(Object.values(snap.flows?.activeUsers || {})) : null };
        });
    }



    _activeByRole(logins) {
        const users = new Map();
        for (const login of logins) users.set(String(login.actor?.userId), login.actor?.role);
        return countBy([...users.values()].map(role => ({ role })), r => r.role);
    }



    _documents(documents, period) {
        const entries = documents.flatMap(d => (d.documents || [])
            .filter(e => !e.isDeleted)
            .map(e => ({ ...e, userRole: d.userRole })));

        const measure = (start, end) => {
            const verified = entries.filter(e => e.verifiedAt && e.verifiedAt >= start && e.verifiedAt < end);
            return {
                verified: verified.length,
                autoVerifiedShare: ratio(verified.filter(e => e.verificationStatus === 'auto-verified').length, verified.length),
                medianHoursToVerify: median(verified.filter(e => e.uploadedAt).map(e => hoursBetween(e.uploadedAt, e.verifiedAt)))
            };
        };

        const uploaded = entries.filter(e => e.uploadedAt && e.uploadedAt >= period.start && e.uploadedAt < period.end);
        return {
            current: measure(period.start, period.end),
            previous: measure(period.compareStart, period.compareEnd),
            backlog: entries.filter(e => PENDING_DOCUMENT_STATUSES.includes(e.verificationStatus)).length,
            byType: countBy(uploaded, e => e.documentType).map(({ key, count }) => {
                const list = uploaded.filter(e => e.documentType === key);
                return {
                    documentType: key,
                    uploaded: count,
                    verified: list.filter(e => ['verified', 'auto-verified'].includes(e.verificationStatus)).length,
                    rejected: list.filter(e => e.verificationStatus === 'rejected').length
                };
            })
        };
    }
}

module.exports = new EngagementAnalytics();
