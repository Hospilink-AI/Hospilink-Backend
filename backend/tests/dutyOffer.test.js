// In-memory stand-ins for the database, cache, settings and notifications
const settings = {
    'offer.featureEnabled': true,
    'offer.startRadiusKm': 30,
    'offer.stepKm': 5,
    'offer.stepMinutes': 60,
    'offer.maxRadiusKm': 75
};
jest.mock('../src/services/systemConfig.service', () => ({
    getManyEffective: async (keys) => Object.fromEntries(keys.map(k => [k, settings[k]]))
}));
jest.mock('../src/services/cache.service', () => ({ acquireLock: async () => true, releaseLock: async () => true }));
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {} }));
const widenedCalls = [];
jest.mock('../src/services/notificationEmitter', () => ({
    emitDutyOfferWidened: async (duty, userIds, radiusKm) => widenedCalls.push({ radiusKm, userIds })
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
        expect(notified).toEqual(['u5', 'u28']);
        expect(saved.offer.mode).toBe('radius');
        expect(saved.offer.radiusKm).toBe(30);
        expect(saved.offer.notifiedStaff).toEqual(['s5', 's28']);
        expect(saved.offer.nextActionAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60000);
    });

    it('sends an emergency to everyone in the hospital city at once', async () => {
        const duties = [{ _id: 'd2', urgency: 'emergency', staffRole: 'rmo' }];
        const notified = await dutyOffer.startOffer(duties, HOSPITAL);
        expect(notified).toEqual(['u5', 'u28', 'u33']);
        expect(saved.offer).toMatchObject({ mode: 'city', city: 'pune' });
        expect(saved.offer.nextActionAt).toBeUndefined();
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
