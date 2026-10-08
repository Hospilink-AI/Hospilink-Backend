// A hospital raises the hourly rate of an open duty. The raise is recorded and
// doctors already offered the duty hear about it.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));

const mongoose = require('mongoose');
const Duty = require('../src/models/Duty');
const Hospital = require('../src/models/Hospital');
const MedicalStaff = require('../src/models/MedicalStaff');
const notificationEmitter = require('../src/services/notificationEmitter');
const blockService = require('../src/services/block.service');
const raiseService = require('../src/services/dutyRateRaise.service');
const { validateRaiseRate } = require('../src/middleware/validation.middleware');
const router = require('../src/routes/duty.routes');

const hospitalId = new mongoose.Types.ObjectId();
const notifiedA = new mongoose.Types.ObjectId();
const invitedB = new mongoose.Types.ObjectId();
const blockedC = new mongoose.Types.ObjectId();
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
tomorrow.setUTCHours(0, 0, 0, 0);

let duty;
let update;
let notices;

const lean = (value) => ({ select: () => ({ lean: async () => value }), lean: async () => value });

beforeEach(() => {
    update = null;
    notices = [];
    duty = {
        _id: new mongoose.Types.ObjectId(),
        hospital: hospitalId,
        status: 'available',
        staffRole: 'icu_nurse',
        date: tomorrow,
        startTime: '20:00',
        endTime: '08:00',
        isOvernightDuty: true,
        offeredRate: 200,
        totalPayment: 2400,
        offer: { notifiedStaff: [notifiedA, blockedC], invitedStaff: [invitedB] },
        autoRelist: { excludedStaff: [] }
    };
    Hospital.findOne = () => lean({ _id: hospitalId, hospitalLegalName: 'TEST - City Hospital' });
    Duty.findById = () => lean(duty);
    Duty.findOneAndUpdate = async (filter, change) => {
        update = { filter, change };
        if (filter.offeredRate !== duty.offeredRate || duty.status !== 'available') return null;
        return { ...duty, ...change.$set };
    };
    MedicalStaff.find = (q) => lean(q._id.$in.map(id => ({ user: `user-${id}` })));
    blockService.staffHiddenFrom = async () => [String(blockedC)];
    notificationEmitter.emitDutyNotice = async (type, d, userIds, message, extra) => { notices.push({ type, userIds, message, extra }); };
});

const settle = () => new Promise(r => setImmediate(r));

describe('raise rate', () => {
    it('raises the rate, recomputes the total and records the raise', async () => {
        const updated = await raiseService.raise(duty._id, 'hospital-user', 250);
        expect(updated.offeredRate).toBe(250);
        expect(updated.totalPayment).toBe(3000);
        expect(update.filter).toMatchObject({ status: 'available', offeredRate: 200 });
        expect(update.change.$set.rateRaise).toMatchObject({ previousRate: 200, by: 'hospital-user' });
        expect(update.change.$push.rateRaises).toMatchObject({ previousRate: 200, newRate: 250 });
    });

    it('tells doctors already offered or invited, but not blocked ones', async () => {
        await raiseService.raise(duty._id, 'hospital-user', 250);
        await settle();
        expect(notices).toHaveLength(1);
        expect(notices[0].type).toBe('NEW_DUTY_OFFER');
        expect(notices[0].userIds.sort()).toEqual([`user-${invitedB}`, `user-${notifiedA}`].sort());
        expect(notices[0].message).toMatch(/^Rate raised to ₹250\/hr: Icu Nurse at TEST - City Hospital/);
        expect(notices[0].extra.rateRaise).toMatchObject({ previousRate: 200, newRate: 250 });
    });

    it.each([
        [200, 'The new rate must be higher than ₹200/hr.'],
        [150, 'The new rate must be higher than ₹200/hr.'],
        [900, "The total can't be more than ₹9,999."]
    ])('refuses %s', async (rate, message) => {
        await expect(raiseService.raise(duty._id, 'hospital-user', rate)).rejects.toThrow(message);
        expect(update).toBeNull();
    });

    it('refuses a duty that someone accepted', async () => {
        duty.status = 'assigned';
        await expect(raiseService.raise(duty._id, 'hospital-user', 250)).rejects.toThrow('only raise the rate while the duty is open');
    });

    it('refuses another hospital', async () => {
        duty.hospital = new mongoose.Types.ObjectId();
        await expect(raiseService.raise(duty._id, 'hospital-user', 250)).rejects.toThrow('your own duties');
    });

    it('refuses an anesthesia booking', async () => {
        duty.pricing = { mode: 'fixed' };
        await expect(raiseService.raise(duty._id, 'hospital-user', 250)).rejects.toThrow('one price for the case');
    });

    it('is allowed 10 minutes before the start, unlike an ordinary edit', async () => {
        const soon = new Date(Date.now() + 10 * 60 * 1000);
        const start = new Date(soon.getTime());
        duty.date = new Date(new Date(start).setHours(0, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
        duty.startTime = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
        duty.endTime = `${String((start.getHours() + 8) % 24).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
        duty.isOvernightDuty = start.getHours() + 8 >= 24;
        await expect(raiseService.raise(duty._id, 'hospital-user', 250)).resolves.toBeTruthy();
    });

    it('reports a conflict when the rate changed meanwhile', async () => {
        Duty.findOneAndUpdate = async () => null;
        await expect(raiseService.raise(duty._id, 'hospital-user', 250)).rejects.toThrow('changed while you were raising');
    });
});

describe('raise rate request', () => {
    function validate(body) {
        let passed = false;
        const res = { status: () => res, json: () => res };
        validateRaiseRate({ body }, res, () => { passed = true; });
        return passed;
    }

    it('takes only offered_rate as a positive number', () => {
        expect(validate({ offered_rate: 250 })).toBe(true);
        expect(validate({ offered_rate: '250' })).toBe(false);
        expect(validate({ offered_rate: -1 })).toBe(false);
        expect(validate({ offered_rate: 250, note: 'x' })).toBe(false);
    });

    it('is a hospital route', () => {
        const layer = router.stack.find(l => l.route && l.route.path === '/duties/:id/raise-rate');
        expect(layer.route.methods.post).toBe(true);
    });
});

describe('raise in the duty', () => {
    it('is absent on duties never raised and sent when present', () => {
        const plain = new Duty({ staffRole: 'nurse', date: tomorrow, startTime: '09:00', endTime: '17:00' });
        expect(plain.toObject().rateRaise).toBeUndefined();
        const raised = new Duty({ staffRole: 'nurse', date: tomorrow, startTime: '09:00', endTime: '17:00', rateRaise: { previousRate: 200, raisedAt: new Date() } });
        expect(JSON.parse(JSON.stringify(raised)).rateRaise.previousRate).toBe(200);
    });
});
