const MedicalStaff = require('../models/MedicalStaff');
const User = require('../models/User');
const notificationEmitter = require('./notificationEmitter');
const EmailService = require('./email.service');
const logger = require('../utils/logger');
const { istDateKey, daysBetweenKeys } = require('../utils/calendar.helper');

// A new doctor who hasn't uploaded the required documents hears on these days
// after sign-up, then never again
const REMINDER_DAYS = [1, 3, 7];
const LAST_DAY = REMINDER_DAYS[REMINDER_DAYS.length - 1];
const DAY_MS = 24 * 60 * 60 * 1000;
// IST hour from which the day's reminders go out
const SEND_FROM_HOUR_IST = 10;

// Reminders already sent: one per distinct time, whatever the channels
function sentCount(staff) {
    return new Set((staff.reminders?.documents || []).map(r => new Date(r.at).getTime())).size;
}

// Whether a reminder is due today for a doctor who signed up on signupKey
function isDue(staff, todayKey) {
    const days = daysBetweenKeys(istDateKey(staff.createdAt), todayKey);
    const sent = sentCount(staff);
    return sent < REMINDER_DAYS.length && days >= REMINDER_DAYS[sent] && days <= LAST_DAY;
}

function istHour(now) {
    return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();
}

class VerificationReminderService {
    // Daily sweep. Returns the number of doctors reminded.
    async runDue(now = new Date()) {
        if (istHour(now) < SEND_FROM_HOUR_IST) return 0;

        const todayKey = istDateKey(now);
        const candidates = await MedicalStaff.find({
            createdAt: { $gte: new Date(now.getTime() - (LAST_DAY + 1) * DAY_MS) },
            verificationStatus: { $ne: 'verified' },
            isDocumentsUploaded: { $ne: true },
            isDemo: { $ne: true }
        })
            .select('user fullName createdAt reminders.documents')
            .lean();

        const due = candidates.filter(s => isDue(s, todayKey));
        if (due.length === 0) return 0;

        // Skip anyone who asked to delete their account
        const users = await User.find({
            _id: { $in: due.map(s => s.user) },
            'deletion.requestedAt': { $exists: false }
        }).select('email name').lean();
        const usersById = new Map(users.map(u => [String(u._id), u]));

        let reminded = 0;
        for (const staff of due) {
            const user = usersById.get(String(staff.user));
            if (!user) continue;
            try {
                await this._remind(staff, user, now);
                reminded++;
            } catch (err) {
                logger.error(`Documents reminder failed for staff ${staff._id}: ${err.message}`);
            }
        }
        return reminded;
    }

    async _remind(staff, user, at) {
        const channels = [];
        await notificationEmitter.emitDocumentsReminder(String(staff.user));
        channels.push('push');
        if (user.email && await EmailService.sendDocumentsReminderEmail(user.email, staff.fullName || user.name || 'Doctor')) {
            channels.push('email');
        }

        // The daily cron lock keeps two servers from sending the same reminder
        await MedicalStaff.updateOne(
            { _id: staff._id },
            { $push: { 'reminders.documents': { $each: channels.map(channel => ({ at, channel })) } } }
        );
    }
}

module.exports = new VerificationReminderService();
module.exports.REMINDER_DAYS = REMINDER_DAYS;
module.exports.isDue = isDue;
