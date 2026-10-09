// The offer-widening job against a real database. Its query once asked for a
// field and its child together, which MongoDB rejects ("Path collision"), so
// offers never widened.
jest.setTimeout(180000);
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/cache.service', () => ({
    acquireLock: async () => true,
    releaseLock: async () => true,
    get: async () => null,
    set: async () => true,
    del: async () => true
}));
jest.mock('../../src/services/staffLocator.service', () => ({ findInRadius: async () => [], findInCity: async () => [] }));
jest.mock('../../src/services/block.service', () => ({ staffHiddenFrom: async () => [] }));
jest.mock('../../src/services/notificationEmitter', () => new Proxy({}, { get: () => async () => {} }));

const mongoose = require('mongoose');
const db = require('./db');
const Duty = require('../../src/models/Duty');
const Hospital = require('../../src/models/Hospital');
const dutyOfferService = require('../../src/services/dutyOffer.service');
const logger = require('../../src/utils/logger');

beforeAll(db.start);
afterAll(db.stop);

test('a due radius offer widens one step', async () => {
    const hospitalId = new mongoose.Types.ObjectId();
    await db.raw(Hospital, {
        _id: hospitalId,
        user: new mongoose.Types.ObjectId(),
        hospitalLegalName: 'TEST Hospital',
        city: 'Pune',
        coordinates: { type: 'Point', coordinates: { latitude: 18.52, longitude: 73.85 } }
    });
    const dutyId = new mongoose.Types.ObjectId();
    await db.raw(Duty, {
        _id: dutyId,
        hospital: hospitalId,
        staffRole: 'rmo',
        status: 'available',
        date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        startTime: '09:00',
        endTime: '17:00',
        offer: {
            mode: 'radius',
            radiusKm: 30,
            maxRadiusKm: 75,
            stepKm: 5,
            stepMinutes: 60,
            nextActionAt: new Date(Date.now() - 60 * 1000),
            notifiedStaff: [new mongoose.Types.ObjectId()],
            pendingStaff: [],
            history: []
        }
    });
    jest.spyOn(dutyOfferService, 'getSettings').mockResolvedValue({});

    const widened = await dutyOfferService.runDue();

    expect(logger.error).not.toHaveBeenCalled();
    expect(widened).toBe(1);
    const stored = await Duty.findById(dutyId).select('+offer.notifiedStaff').lean();
    expect(stored.offer.radiusKm).toBe(35);
    expect(stored.offer.history.at(-1)).toMatchObject({ event: 'expanded', radiusKm: 35 });
    expect(stored.offer.notifiedStaff).toHaveLength(1);
    expect(stored.offer.nextActionAt.getTime()).toBeGreaterThan(Date.now());
});
