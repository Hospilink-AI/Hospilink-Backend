const StaffAvailability = require('../models/StaffAvailability');
const MedicalStaff = require('../models/MedicalStaff');
const notificationService = require('./notificationService');
const notificationDelivery = require('./notificationDelivery.service');
const logger = require('../utils/logger');
const { NotFoundError } = require('../middleware/error.middleware');
const { resolveDay, isFreeFor } = require('../utils/availability.helper');
const { istDateKey, istDayStart, addDaysToKey, daysBetweenKeys } = require('../utils/calendar.helper');

// A weekly pattern counts for this long after it was last saved
const PATTERN_VALID_DAYS = 56;
const REMINDER_DAYS_BEFORE = 7;

class StaffAvailabilityService {
    async _staffFor(staffUserId) {
        const staff = await MedicalStaff.findOne({ user: staffUserId }).select('_id').lean();
        if (!staff) throw new NotFoundError('Medical staff profile not found');
        return staff;
    }

    _shape(doc) {
        return {
            weekly: doc?.weekly || [],
            validUntil: doc?.validUntil ? istDateKey(doc.validUntil) : null,
            exceptions: doc?.exceptions || []
        };
    }



    // GET /api/staff/availability?from&to — the pattern plus each day resolved
    async getForStaff(staffUserId, from, to) {
        const staff = await this._staffFor(staffUserId);
        const doc = await StaffAvailability.findOne({ staff: staff._id }).lean();

        const days = [];
        for (let i = 0; i <= daysBetweenKeys(from, to); i++) {
            const date = addDaysToKey(from, i);
            days.push({ date, ...resolveDay(doc, date) });
        }
        return { ...this._shape(doc), days };
    }

    // PUT /api/staff/availability/weekly — replaces the pattern and restarts its validity
    async setWeekly(staffUserId, weekly) {
        const staff = await this._staffFor(staffUserId);
        const validUntil = istDayStart(addDaysToKey(istDateKey(new Date()), PATTERN_VALID_DAYS));
        const doc = await StaffAvailability.findOneAndUpdate(
            { staff: staff._id },
            { $set: { weekly, validUntil, reminderSentAt: null } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();
        return this._shape(doc);
    }

    // PUT /api/staff/availability/dates — sets or clears single days
    //   dates: [{ date, status: 'free' | 'busy' | 'clear', from?, to? }]
    async setDates(staffUserId, dates) {
        const staff = await this._staffFor(staffUserId);
        const existing = await StaffAvailability.findOne({ staff: staff._id }).lean();
        const todayKey = istDateKey(new Date());

        const byDate = new Map((existing?.exceptions || [])
            .filter(e => e.date >= todayKey) // past days are no longer needed
            .map(e => [e.date, e]));
        for (const { date, status, from, to } of dates) {
            if (status === 'clear') byDate.delete(date);
            else byDate.set(date, { date, status, ...(from && { from }), ...(to && { to }) });
        }

        const exceptions = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
        const doc = await StaffAvailability.findOneAndUpdate(
            { staff: staff._id },
            { $set: { exceptions } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();
        return this._shape(doc);
    }



    // Of these staff, the ones who said they are free for the whole shift
    async freeFor(staffIds, dateKey, startTime, endTime) {
        if (!staffIds.length || !dateKey) return new Set();
        const docs = await StaffAvailability.find({ staff: { $in: staffIds } }).lean();
        return new Set(docs.filter(d => isFreeFor(d, dateKey, startTime, endTime)).map(d => String(d.staff)));
    }



    // Reminds doctors a week before their weekly pattern stops counting
    async sendExpiryReminders() {
        const now = new Date();
        const soon = new Date(now.getTime() + REMINDER_DAYS_BEFORE * 24 * 60 * 60 * 1000);
        const due = await StaffAvailability.find({
            validUntil: { $gt: now, $lte: soon },
            'weekly.0': { $exists: true },
            reminderSentAt: null
        }).select('staff validUntil').lean();
        if (!due.length) return 0;

        const staff = await MedicalStaff.find({ _id: { $in: due.map(d => d.staff) } }).select('_id user').lean();
        const userByStaff = new Map(staff.map(s => [String(s._id), String(s.user)]));

        let sent = 0;
        for (const doc of due) {
            const userId = userByStaff.get(String(doc.staff));
            if (!userId) continue;
            try {
                const endsOn = new Date(doc.validUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
                const payload = {
                    type: 'AVAILABILITY_EXPIRING',
                    validUntil: istDateKey(doc.validUntil),
                    message: `Your weekly availability stops counting on ${endsOn}. Open your calendar to keep it up to date.`,
                    timestamp: now.toISOString()
                };
                const { unreadCount } = await notificationService.createNotificationWithCount(userId, 'AVAILABILITY_EXPIRING', payload);
                await notificationDelivery.deliverToUser(userId, 'AVAILABILITY_EXPIRING', payload, unreadCount);
                await StaffAvailability.updateOne({ _id: doc._id }, { $set: { reminderSentAt: now } });
                sent++;
            } catch (error) {
                logger.error('Error sending availability reminder:', error);
            }
        }
        return sent;
    }
}

module.exports = new StaffAvailabilityService();
