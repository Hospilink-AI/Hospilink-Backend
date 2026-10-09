// Doctors choose which pushes they get, their language and how far they travel.
// Without saved preferences everything works as before.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockCache = new Map();
jest.mock('../src/services/cache.service', () => ({
    get: async (k) => (mockCache.has(k) ? JSON.parse(mockCache.get(k)) : null),
    set: async (k, v) => { mockCache.set(k, JSON.stringify(v)); return true; },
    del: async (k) => { mockCache.delete(k); return true; },
    acquireLock: async () => true, releaseLock: async () => true
}));
const mockPushes = [];
jest.mock('../src/services/fcm.service', () => ({
    sendToUser: async (userId) => { mockPushes.push(userId); return { success: true }; },
    sendToUsers: async (ids) => { mockPushes.push(...ids); return { successCount: ids.length, failureCount: 0 }; }
}));
jest.mock('../src/services/websocketManager', () => ({
    isUserOnline: () => false, onlineAmong: async () => new Set(), emitToUser: () => {}, sendUnreadCount: () => {}
}));

const MedicalStaff = require('../src/models/MedicalStaff');
const prefs = require('../src/services/staffPreferences.service');
const delivery = require('../src/services/notificationDelivery.service');
const { validatePreferencesUpdate } = require('../src/middleware/validation.middleware');

let saved;
let findCalls;
beforeEach(() => {
    mockCache.clear();
    mockPushes.length = 0;
    findCalls = 0;
    saved = { 'u-off': { notifications: { offers: false } }, 'u-quiet': { notifications: { reminders: false, support: false } } };
    MedicalStaff.find = (filter) => {
        findCalls++;
        const rows = filter.user.$in.filter(id => saved[id]).map(id => ({ user: id, preferences: saved[id] }));
        return { select: () => ({ lean: async () => rows }) };
    };
});

describe('push preferences', () => {
    it('maps types to the setting that turns them off', () => {
        expect(prefs.preferenceFor('NEW_DUTY_OFFER')).toBe('offers');
        expect(prefs.preferenceFor('DUTY_INVITE')).toBe('offers');
        expect(prefs.preferenceFor('DOCUMENTS_REMINDER')).toBe('reminders');
        expect(prefs.preferenceFor('TICKET_CHAT_MESSAGE')).toBe('support');
        // Always pushed
        expect(prefs.preferenceFor('DUTY_CANCELLED_BY_HOSPITAL')).toBeNull();
        expect(prefs.preferenceFor('TICKET_RESPONSE_WINDOW_CLOSING')).toBeNull();
        expect(prefs.preferenceFor('SUSPENSION_PROPOSED')).toBeNull();
    });

    it('skips doctors who turned offers off, in one query, and caches the answer', async () => {
        await delivery.deliverToUsers(['u-off', 'u-default', 'u-quiet'], 'NEW_DUTY_OFFER', { message: 'x' });
        expect(mockPushes.sort()).toEqual(['u-default', 'u-quiet']);
        expect(findCalls).toBe(1);
        await delivery.deliverToUsers(['u-off', 'u-default'], 'NEW_DUTY_OFFER', { message: 'x' });
        expect(findCalls).toBe(1);
    });

    it('applies to single pushes too', async () => {
        const result = await delivery.deliverToUser('u-quiet', 'DOCUMENTS_REMINDER', { message: 'x' });
        expect(result.reason).toBe('preference');
        expect(mockPushes).toEqual([]);
        await delivery.deliverToUser('u-quiet', 'NEW_DUTY_OFFER', { message: 'x' });
        expect(mockPushes).toEqual(['u-quiet']);
    });

    it('never filters types without a setting, and reads nothing for them', async () => {
        await delivery.deliverToUsers(['u-off'], 'DUTY_CANCELLED_BY_HOSPITAL', { message: 'x' });
        expect(mockPushes).toEqual(['u-off']);
        expect(findCalls).toBe(0);
    });

    it('pushes to everyone if preferences cannot be read', async () => {
        MedicalStaff.find = () => { throw new Error('db down'); };
        await delivery.deliverToUsers(['u-off'], 'NEW_DUTY_OFFER', { message: 'x' });
        expect(mockPushes).toEqual(['u-off']);
    });
});

describe('reading and saving preferences', () => {
    it('fills defaults for a doctor who never saved any', async () => {
        MedicalStaff.findOne = () => ({ select: () => ({ lean: async () => ({}) }) });
        expect(await prefs.get('u1')).toEqual({
            notifications: { offers: true, reminders: true, support: true, marketing: false },
            language: 'en',
            maxDistanceKm: null
        });
    });

    it('saves only the fields sent and clears the cache', async () => {
        let update;
        mockCache.set('staff:prefs:u1', JSON.stringify('none'));
        MedicalStaff.findOneAndUpdate = (filter, u) => {
            update = u;
            return { select: () => ({ lean: async () => ({ preferences: { notifications: { offers: false }, maxDistanceKm: 25 } }) }) };
        };
        const result = await prefs.update('u1', { notifications: { offers: false }, maxDistanceKm: 25 });
        expect(update).toEqual({ $set: { 'preferences.notifications.offers': false, 'preferences.maxDistanceKm': 25 } });
        expect(result.notifications).toEqual({ offers: false, reminders: true, support: true, marketing: false });
        expect(mockCache.has('staff:prefs:u1')).toBe(false);
    });

    it('null clears the distance limit', async () => {
        let update;
        MedicalStaff.findOneAndUpdate = (filter, u) => { update = u; return { select: () => ({ lean: async () => ({ preferences: {} }) }) }; };
        await prefs.update('u1', { maxDistanceKm: null });
        expect(update).toEqual({ $unset: { 'preferences.maxDistanceKm': 1 } });
    });
});

describe('preferences request', () => {
    const validate = (body) => {
        let passed = false;
        const res = { status: () => res, json: () => res };
        validatePreferencesUpdate({ body }, res, () => { passed = true; });
        return passed;
    };

    it('accepts the documented shape', () => {
        expect(validate({ notifications: { offers: true, marketing: false }, language: 'hi', maxDistanceKm: 30 })).toBe(true);
        expect(validate({ maxDistanceKm: null })).toBe(true);
    });

    it.each([
        [{}],
        [{ notifications: { sms: true } }],
        [{ notifications: { offers: 'yes' } }],
        [{ language: 'fr' }],
        [{ maxDistanceKm: 0 }],
        [{ maxDistanceKm: 12.5 }],
        [{ theme: 'dark' }]
    ])('refuses %j', (body) => {
        expect(validate(body)).toBe(false);
    });
});
