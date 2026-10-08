// A duty's total must be ₹499-₹9,999 and it must run 3-24 hours. Anesthesia
// bookings have no price limit but keep the hour rules.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));

const mongoose = require('mongoose');
const { priceRuleError, dutyHoursAndTotal } = require('../src/utils/dutyPricing');
const { validateDutyCreation } = require('../src/middleware/validation.middleware');
const Duty = require('../src/models/Duty');
const Hospital = require('../src/models/Hospital');
const DutyService = require('../src/services/duty.service');

// Tomorrow, so the 15-minute rule never gets in the way
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function create(body) {
    let status = 200;
    let payload = null;
    let passed = false;
    const res = { status: (s) => { status = s; return res; }, json: (p) => { payload = p; return res; } };
    validateDutyCreation({ body: { date: tomorrow, urgency: 'medium', staff_role: 'nurse', ...body } }, res, () => { passed = true; });
    return { passed, status, errors: payload ? payload.errors : [] };
}

describe('price rules', () => {
    it('work out the total like the duty itself', () => {
        expect(dutyHoursAndTotal({ date: tomorrow, startTime: '09:00', endTime: '17:00', offeredRate: 200 }))
            .toEqual({ hours: 8, total: 1600 });
        expect(dutyHoursAndTotal({ date: tomorrow, startTime: '20:00', endTime: '08:00', isOvernightDuty: true, offeredRate: 100 }))
            .toEqual({ hours: 12, total: 1200 });
    });

    it.each([
        [{ startTime: '09:00', endTime: '17:00', offeredRate: 62 }, 'The total must be at least ₹499.'],
        [{ startTime: '09:00', endTime: '21:00', offeredRate: 900 }, "The total can't be more than ₹9,999."],
        [{ startTime: '09:00', endTime: '11:00', offeredRate: 500 }, 'A duty must be at least 3 hours long.'],
        [{ startTime: '09:00', endTime: '17:00', offeredRate: 200 }, null],
        [{ startTime: '09:00', endTime: '12:00', offeredRate: 167 }, null],
        [{ startTime: '09:00', endTime: '17:00', offeredRate: 1249 }, null]
    ])('%j -> %s', (fields, expected) => {
        expect(priceRuleError({ date: tomorrow, ...fields })).toBe(expected);
    });

    it('refuse more than 24 hours', () => {
        const twoDaysLater = new Date(Date.parse(tomorrow) + 2 * 24 * 60 * 60 * 1000);
        expect(priceRuleError({ date: tomorrow, endDate: twoDaysLater, startTime: '09:00', endTime: '09:00', offeredRate: 10 }))
            .toBe("A duty can't be longer than 24 hours.");
    });

    it('leave anesthesia without a price limit but keep the hours', () => {
        expect(priceRuleError({ date: tomorrow, startTime: '09:00', endTime: '13:00', offeredRate: 5000, category: 'anesthesia' })).toBeNull();
        expect(priceRuleError({ date: tomorrow, startTime: '09:00', endTime: '11:00', offeredRate: 5000, category: 'anesthesia' }))
            .toBe('A duty must be at least 3 hours long.');
    });
});

describe('creating a duty', () => {
    it('refuses a total under ₹499', () => {
        const result = create({ start_time: '09:00', end_time: '17:00', offered_rate: 50 });
        expect(result.passed).toBe(false);
        expect(result.status).toBe(400);
        expect(result.errors).toContain('The total must be at least ₹499.');
    });

    it('accepts a duty inside the rules', () => {
        expect(create({ start_time: '09:00', end_time: '17:00', offered_rate: 200 }).passed).toBe(true);
    });

    it('accepts an anesthesia booking above ₹9,999', () => {
        expect(create({
            staff_role: 'anesthetist', category: 'anesthesia', pricing_mode: 'fixed', fixed_price: 12000,
            case_note: 'Total knee replacement', start_time: '09:00', end_time: '13:00', offered_rate: 3000
        }).passed).toBe(true);
    });
});

describe('editing a duty', () => {
    const hospitalId = new mongoose.Types.ObjectId();
    let duty;
    let saved;

    beforeEach(() => {
        saved = false;
        duty = new Duty({
            hospital: hospitalId, staffRole: 'nurse', date: new Date(tomorrow), startTime: '09:00', endTime: '17:00',
            offeredRate: 200, urgency: 'medium', status: 'available'
        });
        duty.save = async () => { saved = true; return duty; };
        duty.populate = async () => duty;
        Hospital.findOne = async () => ({ _id: hospitalId });
        Duty.findById = async () => duty;
    });

    it('refuses a rate that takes the total over ₹9,999', async () => {
        await expect(DutyService.editDuty(duty._id, 'u1', { offeredRate: 2000 })).rejects.toThrow("The total can't be more than ₹9,999.");
        expect(saved).toBe(false);
    });

    it('refuses new times shorter than 3 hours', async () => {
        await expect(DutyService.editDuty(duty._id, 'u1', { endTime: '10:00' })).rejects.toThrow('A duty must be at least 3 hours long.');
    });

    it('lets an old duty below the rules change its description', async () => {
        duty.offeredRate = 10;
        await DutyService.editDuty(duty._id, 'u1', { description: 'Bring your own scrubs' });
        expect(saved).toBe(true);
    });

    it('allows an edit inside the rules', async () => {
        await DutyService.editDuty(duty._id, 'u1', { offeredRate: 250 });
        expect(saved).toBe(true);
    });
});
