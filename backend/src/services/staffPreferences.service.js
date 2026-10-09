const MedicalStaff = require('../models/MedicalStaff');
const cacheService = require('./cache.service');
const logger = require('../utils/logger');
const { TYPES } = require('../utils/notificationDisplay');
const { NotFoundError } = require('../middleware/error.middleware');

// What a doctor gets when they never saved preferences: today's behaviour
const DEFAULTS = Object.freeze({
    notifications: { offers: true, reminders: true, support: true, marketing: false },
    language: 'en',
    maxDistanceKm: null
});
const LANGUAGES = ['en', 'hi', 'mr'];
const NOTIFICATION_KEYS = Object.keys(DEFAULTS.notifications);
const CACHE_TTL_SECONDS = 600;
// Stored for doctors without saved preferences, so they cost no database read either
const NONE = 'none';

// Which preference turns off the push for a notification type. Types not
// listed always push: duty changes, payments, safety and account notices.
const OFFER_TYPES = new Set(['NEW_DUTY_OFFER', 'DUTY_INVITE', 'EMERGENCY_DUTY_REQUEST']);
const REMINDER_TYPES = new Set(['AVAILABILITY_EXPIRING', 'DOCUMENTS_REMINDER', 'RATE_HOSPITAL_PROMPT']);

function preferenceFor(type) {
    if (OFFER_TYPES.has(type)) return 'offers';
    if (REMINDER_TYPES.has(type)) return 'reminders';
    // Ticket updates only; response deadlines and account reviews always push
    const meta = TYPES[type];
    if (meta && meta.category === 'support' && meta.severity === 'info') return 'support';
    return null;
}

function effective(stored) {
    return {
        notifications: { ...DEFAULTS.notifications, ...(stored?.notifications || {}) },
        language: stored?.language || DEFAULTS.language,
        maxDistanceKm: typeof stored?.maxDistanceKm === 'number' ? stored.maxDistanceKm : null
    };
}

const cacheKey = (userId) => `staff:prefs:${userId}`;

class StaffPreferencesService {
    async get(userId) {
        const staff = await MedicalStaff.findOne({ user: userId }).select('preferences').lean();
        if (!staff) throw new NotFoundError('Medical staff profile not found');
        return effective(staff.preferences);
    }

    // changes: { notifications?: {offers?, reminders?, support?, marketing?}, language?, maxDistanceKm? (null clears) }
    async update(userId, changes) {
        const $set = {};
        const $unset = {};
        for (const key of NOTIFICATION_KEYS) {
            if (typeof changes.notifications?.[key] === 'boolean') {
                $set[`preferences.notifications.${key}`] = changes.notifications[key];
            }
        }
        if (changes.language !== undefined) $set['preferences.language'] = changes.language;
        if (changes.maxDistanceKm === null) $unset['preferences.maxDistanceKm'] = 1;
        else if (changes.maxDistanceKm !== undefined) $set['preferences.maxDistanceKm'] = changes.maxDistanceKm;

        const update = {};
        if (Object.keys($set).length) update.$set = $set;
        if (Object.keys($unset).length) update.$unset = $unset;

        const staff = await MedicalStaff.findOneAndUpdate({ user: userId }, update, { new: true })
            .select('preferences')
            .lean();
        if (!staff) throw new NotFoundError('Medical staff profile not found');

        await cacheService.del(cacheKey(userId));
        return effective(staff.preferences);
    }

    // Saved preferences of these users, or null for users without any.
    // Cached; misses are read in one query.
    async storedFor(userIds) {
        const ids = [...new Set(userIds.map(String))];
        const result = new Map();
        const misses = [];
        await Promise.all(ids.map(async (id) => {
            const cached = await cacheService.get(cacheKey(id));
            if (cached === null || cached === undefined) misses.push(id);
            else result.set(id, cached === NONE ? null : cached);
        }));

        if (misses.length) {
            const rows = await MedicalStaff.find({ user: { $in: misses }, preferences: { $exists: true } })
                .select('user preferences')
                .lean();
            const found = new Map(rows.map(r => [String(r.user), r.preferences]));
            await Promise.all(misses.map(async (id) => {
                const prefs = found.get(id) || null;
                result.set(id, prefs);
                await cacheService.set(cacheKey(id), prefs || NONE, CACHE_TTL_SECONDS);
            }));
        }
        return result;
    }

    // The users who still get a push of this type. Fails open: if preferences
    // can't be read, everyone gets the push as before.
    async filterPushRecipients(userIds, type) {
        const key = preferenceFor(type);
        if (!key || !userIds?.length) return userIds || [];
        try {
            const stored = await this.storedFor(userIds);
            return userIds.filter(id => effective(stored.get(String(id))).notifications[key] !== false);
        } catch (error) {
            logger.warn(`Notification preferences unavailable, pushing to all: ${error.message}`);
            return userIds;
        }
    }

    async maxDistanceKm(userId) {
        try {
            const stored = await this.storedFor([userId]);
            return effective(stored.get(String(userId))).maxDistanceKm;
        } catch (error) {
            return null;
        }
    }
}

module.exports = new StaffPreferencesService();
module.exports.DEFAULTS = DEFAULTS;
module.exports.LANGUAGES = LANGUAGES;
module.exports.preferenceFor = preferenceFor;
