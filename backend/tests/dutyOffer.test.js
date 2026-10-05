// In-memory stand-ins for the database, cache, settings and notifications
const settings = {
    'offer.featureEnabled': true,
    'offer.startRadiusKm': 30,
    'offer.stepKm': 5,
    'offer.stepMinutes': 60,
    'offer.maxRadiusKm': 75,
    'offer.inviteWindowMinutes': 30,
    'offer.availabilityHeadStartMinutes': 10
};
// Doctors who marked themselves free for the shift (empty = nobody declared)
let mockFreeStaff = new Set();
// Nobody is blocked in these tests (tests/block.test.js covers blocking)
jest.mock('../src/services/block.service', () => ({ staffHiddenFrom: async () => [], isBlocked: async () => false }));
jest.mock('../src/services/staffAvailability.service', () => ({
    freeFor: async (ids) => new Set(ids.map(String).filter(id => mockFreeStaff.has(id)))
}));
jest.mock('../src/services/systemConfig.service', () => ({
    getManyEffective: async (keys) => Object.fromEntries(keys.map(k => [k, settings[k]]))
}));
jest.mock('../src/services/cache.service', () => ({ acquireLock: async () => true, releaseLock: async () => true }));
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {} }));
const widenedCalls = [];
const mockNotices = [];
jest.mock('../src/services/notificationEmitter', () => ({
    emitDutyOfferWidened: async (duty, userIds, radiusKm) => widenedCalls.push({ radiusKm, userIds }),
    emitDutyNotice: async (type, duty, userIds, message) => mockNotices.push({ type, userIds, message }),
    describeShift: () => 'rmo duty on 5 Jan, 09:00–17:00'
}));
jest.mock('../src/config/redis', () => ({ getClientAsync: async () => ({}) }));

const HOSPITAL = { _id: 'h1', city: ' Pune ', hospitalLegalName: 'City Hosp', coordinates: { coordinates: { latitude: 18.5204, longitude: 73.8567 } } };
const at = (km) => ({ latitude: 18.5204 + km / 111, longitude: 73.8567 });

// Doctors at known distances north of the hospital
const doctors = [5, 28, 33, 47, 60, 74, 90].map((km, i) => ({ _id: `s${km}`, user: { _id: `u${km}` }, km, city: i < 3 ? 'pune' : 'Mumbai' }));

const staffLocator = require('../src/services/staffLocator.service');
staffLocator.findInRadius = async (center, role, radiusKm, { excludeStaffIds = [] } = {}) =>
    doctors.filter(d => d.km <= radiusKm && !excludeStaffIds.map(String).includes(d._id));
staffLocator.findInCity = async (city) =>
    doctors.filter(d => staffLocator.normalizeCity(d.city) === staffLocator.normalizeCity(city));

const Duty = require('../src/models/Duty');
const Hospital = require('../src/models/Hospital');
const dutyOffer = require('../src/services/dutyOffer.service');

let saved;
Duty.updateMany = async (q, u) => { saved = { ...saved, ...u.$set }; };
Hospital.findById = () => ({ select: async () => HOSPITAL });

describe('eligibility', () => {
    const radiusDuty = { offer: { mode: 'radius', radiusKm: 30 }, hospital: HOSPITAL };

    it('leaves duties without an offer to the old rules', () => {
        expect(dutyOffer.eligibility({}, {}, null, false)).toEqual({ eligible: true, legacy: true });
    });

    it('offers a radius duty only inside the current ring', () => {
        expect(dutyOffer.eligibility(radiusDuty, {}, at(25), false).eligible).toBe(true);
        expect(dutyOffer.eligibility(radiusDuty, {}, at(35), false).eligible).toBe(false);
    });

    it('keeps a duty open to a notified doctor who has since moved away', () => {
        expect(dutyOffer.eligibility(radiusDuty, {}, at(80), true).eligible).toBe(true);
    });

    it('offers an emergency duty to the whole city, whatever the spelling', () => {
        const cityDuty = { offer: { mode: 'city', city: 'pune' }, hospital: HOSPITAL };
        expect(dutyOffer.eligibility(cityDuty, { city: 'PUNE ' }, at(70), false).eligible).toBe(true);
        expect(dutyOffer.eligibility(cityDuty, { city: 'Mumbai' }, at(2), false).eligible).toBe(false);
    });
});

describe('starting an offer', () => {
    beforeEach(() => { saved = {}; });

    it('opens a normal duty at 30 km and schedules the next ring', async () => {
        const duties = [{ _id: 'd1', urgency: 'medium', staffRole: 'rmo' }];
        const notified = await dutyOffer.startOffer(duties, HOSPITAL);
        expect(notified).toEqual({ userIds: ['u5', 'u28'], invited: false });
        expect(saved.offer.mode).toBe('radius');
        expect(saved.offer.radiusKm).toBe(30);
        expect(saved.offer.notifiedStaff).toEqual(['s5', 's28']);
        expect(saved.offer.nextActionAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60000);
    });

    it('sends an emergency to everyone in the hospital city at once', async () => {
        const duties = [{ _id: 'd2', urgency: 'emergency', staffRole: 'rmo' }];
        const notified = await dutyOffer.startOffer(duties, HOSPITAL);
        expect(notified).toEqual({ userIds: ['u5', 'u28', 'u33'], invited: false });
        expect(saved.offer).toMatchObject({ mode: 'city', city: 'pune' });
        expect(saved.offer.nextActionAt).toBeNull();
    });

    it('returns null when staged offers are switched off', async () => {
        settings['offer.featureEnabled'] = false;
        expect(await dutyOffer.startOffer([{ _id: 'd3', urgency: 'low' }], HOSPITAL)).toBeNull();
        settings['offer.featureEnabled'] = true;
    });
});

describe('widening', () => {
    it('grows by 5 km an hour up to 75 km, telling only newly reached doctors', async () => {
        const duty = {
            _id: 'd4', hospital: 'h1', staffRole: 'rmo',
            offer: { mode: 'radius', radiusKm: 30, maxRadiusKm: 75, stepKm: 5, stepMinutes: 60, notifiedStaff: ['s5', 's28'] }
        };
        Duty.findOneAndUpdate = async (q, u) => {
            if (q['offer.radiusKm'] !== duty.offer.radiusKm) return null;
            duty.offer.radiusKm = u.$set['offer.radiusKm'];
            duty.offer.nextActionAt = u.$set['offer.nextActionAt'];
            duty.offer.notifiedStaff.push(...u.$addToSet['offer.notifiedStaff'].$each);
            return duty;
        };

        widenedCalls.length = 0;
        const rings = [];
        while (duty.offer.nextActionAt !== null) {
            await dutyOffer._widen(duty);
            rings.push(duty.offer.radiusKm);
        }

        expect(rings).toEqual([35, 40, 45, 50, 55, 60, 65, 70, 75]);
        expect(widenedCalls.map(c => [c.radiusKm, c.userIds])).toEqual([
            [35, ['u33']], [50, ['u47']], [60, ['u60']], [75, ['u74']]
        ]);
        expect(duty.offer.notifiedStaff).not.toContain('s90');
    });
});

describe('relist', () => {
    it('opens a staged duty to the relist radius and marks those told as notified', async () => {
        const updates = [];
        Duty.updateOne = async (q, u) => updates.push({ q, u });
        await dutyOffer.onRelist({ _id: 'd5', offer: { mode: 'radius' } }, ['s60'], 75);
        expect(updates[0].u.$addToSet['offer.notifiedStaff'].$each).toEqual(['s60']);
        expect(updates[1].u.$set).toEqual({ 'offer.radiusKm': 75, 'offer.nextActionAt': null });
    });

    it('does nothing for duties without an offer', async () => {
        const updates = [];
        Duty.updateOne = async (q, u) => updates.push(u);
        await dutyOffer.onRelist({ _id: 'd6' }, ['s60'], 75);
        expect(updates).toHaveLength(0);
    });
});

describe('availability head start', () => {
    beforeEach(() => { saved = {}; });
    afterEach(() => { mockFreeStaff = new Set(); });

    it('tells doctors free for the shift first and holds the rest for 10 minutes', async () => {
        mockFreeStaff = new Set(['s28']);
        const result = await dutyOffer.startOffer([{ _id: 'd11', urgency: 'medium', staffRole: 'rmo', date: new Date('2027-01-05T00:00:00Z'), startTime: '09:00', endTime: '17:00' }], HOSPITAL);
        expect(result.userIds).toEqual(['u28']);
        expect(saved.offer.notifiedStaff).toEqual(['s28']);
        expect(saved.offer.pendingStaff).toEqual([{ staff: 's5', user: 'u5' }]);
        const minutes = (saved.offer.pendingReleaseAt.getTime() - Date.now()) / 60000;
        expect(minutes).toBeGreaterThan(9);
        expect(minutes).toBeLessThanOrEqual(10);
    });

    it('tells everyone at once when nobody in the ring declared', async () => {
        const result = await dutyOffer.startOffer([{ _id: 'd12', urgency: 'medium', staffRole: 'rmo', date: new Date('2027-01-05T00:00:00Z') }], HOSPITAL);
        expect(result.userIds).toEqual(['u5', 'u28']);
        expect(saved.offer.pendingStaff).toBeUndefined();
    });

    it('gives no head start on emergencies', async () => {
        mockFreeStaff = new Set(['s28']);
        const result = await dutyOffer.startOffer([{ _id: 'd13', urgency: 'emergency', staffRole: 'rmo', date: new Date('2027-01-05T00:00:00Z') }], HOSPITAL);
        expect(result.userIds).toEqual(['u5', 'u28', 'u33']);
    });

    it('releases the held doctors when the head start ends', async () => {
        let update;
        Duty.findOneAndUpdate = async (q, u) => { update = u; return { _id: 'd14', status: 'available', offer: { radiusKm: 30 } }; };
        widenedCalls.length = 0;
        const duty = { _id: 'd14', hospital: 'h1', offer: { radiusKm: 30, notifiedStaff: ['s28'], pendingStaff: [{ staff: 's5', user: 'u5' }], pendingReleaseAt: new Date() } };
        Hospital.findById = () => ({ select: () => ({ lean: async () => HOSPITAL }) });

        expect(await dutyOffer._releasePending(duty)).toBe(true);
        expect(update.$addToSet['offer.notifiedStaff'].$each).toEqual(['s5']);
        expect(update.$set).toEqual({ 'offer.pendingStaff': [], 'offer.pendingReleaseAt': null });
        expect(widenedCalls[0].userIds).toEqual(['u5']);
        expect(duty.offer.notifiedStaff).toEqual(['s28', 's5']);
        Hospital.findById = () => ({ select: async () => HOSPITAL });
    });
});

describe('invites', () => {
    const invitees = [{ _id: 's74', user: { _id: 'u74' } }];

    beforeEach(() => { saved = {}; });

    it('invites named doctors first and schedules opening to others', async () => {
        const result = await dutyOffer.startOffer([{ _id: 'd7', urgency: 'medium', staffRole: 'rmo' }], HOSPITAL, { staff: invitees, openAfterInvite: true });
        expect(result).toEqual({ userIds: ['u74'], invited: true });
        expect(saved.offer).toMatchObject({ mode: 'invite', openAfterInvite: true, openTo: 'radius' });
        expect(saved.offer.notifiedStaff).toEqual(['s74']);
        const minutes = (saved.offer.nextActionAt.getTime() - Date.now()) / 60000;
        expect(minutes).toBeGreaterThan(29);
        expect(minutes).toBeLessThanOrEqual(30);
    });

    it('keeps an invite-only duty closed to everyone else', async () => {
        await dutyOffer.startOffer([{ _id: 'd8', urgency: 'medium', staffRole: 'rmo' }], HOSPITAL, { staff: invitees, openAfterInvite: false });
        expect(saved.offer).toMatchObject({ mode: 'invite', openAfterInvite: false });
        expect(saved.offer.nextActionAt).toBeNull();

        const duty = { offer: { mode: 'invite' }, hospital: HOSPITAL };
        expect(dutyOffer.eligibility(duty, {}, at(2), false).eligible).toBe(false);
        expect(dutyOffer.eligibility(duty, {}, at(80), true).eligible).toBe(true);
    });

    it('opens to the first ring when the invite window ends, skipping the invitees', async () => {
        let update;
        Duty.findOneAndUpdate = async (q, u) => { update = u; return { _id: 'd9', ...u }; };
        widenedCalls.length = 0;
        const duty = { _id: 'd9', hospital: 'h1', staffRole: 'rmo', offer: { mode: 'invite', openTo: 'radius', notifiedStaff: ['s28'] } };

        mockNotices.length = 0;
        expect(await dutyOffer._openAfterInvite(duty)).toBe(true);
        expect(update.$set).toMatchObject({ 'offer.mode': 'radius', 'offer.radiusKm': 30 });
        expect(update.$push['offer.history'].event).toBe('opened_to_radius');
        expect(widenedCalls[0].userIds).toEqual(['u5']);
        expect(mockNotices[0]).toMatchObject({ type: 'DUTY_OPENED_TO_OTHERS' });
        expect(mockNotices[0].message).toContain('now open to doctors within 30 km');
    });

    it('opens an emergency invite to the city', async () => {
        let update;
        Duty.findOneAndUpdate = async (q, u) => { update = u; return { _id: 'd10', ...u }; };
        const duty = { _id: 'd10', hospital: 'h1', staffRole: 'rmo', offer: { mode: 'invite', openTo: 'city', notifiedStaff: [] } };

        await dutyOffer._openAfterInvite(duty);
        expect(update.$set).toMatchObject({ 'offer.mode': 'city', 'offer.city': 'pune' });
        expect(update.$push['offer.history'].event).toBe('opened_to_city');
    });
});
