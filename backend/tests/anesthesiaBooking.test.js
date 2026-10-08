// An anesthesia booking books an anesthetist for one case at one total price.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const Duty = require('../src/models/Duty');
const { anesthesiaErrors, anesthesiaFields } = require('../src/utils/dutyPricing');
const { validateDutyCreation } = require('../src/middleware/validation.middleware');

const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// What the hospital app sends today (src/app/hospital/anesthesia.tsx)
const booking = {
    staff_role: 'anesthetist',
    date: tomorrow,
    start_time: '09:00',
    end_time: '13:00',
    urgency: 'high',
    offered_rate: 1500,
    description: 'Case: Laparoscopic cholecystectomy\n\nPatient fasting from midnight',
    category: 'anesthesia',
    pricing_mode: 'fixed',
    fixed_price: 6000,
    case_note: 'Laparoscopic cholecystectomy'
};

function create(body) {
    let payload = null;
    let passed = false;
    const res = { status: () => res, json: (p) => { payload = p; return res; } };
    validateDutyCreation({ body }, res, () => { passed = true; });
    return { passed, errors: payload ? payload.errors : [] };
}

describe('anesthesia booking request', () => {
    it('accepts what the app sends', () => {
        expect(create(booking)).toEqual({ passed: true, errors: [] });
    });

    it('accepts a total above the ₹9,999 duty limit', () => {
        expect(create({ ...booking, fixed_price: 25000, offered_rate: 6250 }).passed).toBe(true);
    });

    it.each([
        [{ staff_role: 'nurse' }, 'Anesthesia bookings are for anesthetists only.'],
        [{ pricing_mode: 'hourly' }, 'Anesthesia bookings have one price for the case.'],
        [{ fixed_price: 0 }, 'Enter the price for the case.'],
        [{ fixed_price: undefined }, 'Enter the price for the case.'],
        [{ case_note: 'short' }, 'Describe the case in at least 10 characters.'],
        [{ case_note: 'x'.repeat(601) }, "The case note can't be longer than 600 characters."],
        [{ end_time: '11:00' }, 'A duty must be at least 3 hours long.'],
        [{ category: 'surgery' }, 'category must be standard or anesthesia']
    ])('refuses %j', (change, message) => {
        const result = create({ ...booking, ...change });
        expect(result.passed).toBe(false);
        expect(result.errors).toContain(message);
    });

    it('leaves ordinary duties alone', () => {
        expect(anesthesiaErrors({ staff_role: 'nurse' })).toEqual([]);
        expect(anesthesiaFields({ staff_role: 'nurse' })).toEqual({});
        expect(anesthesiaErrors({ category: 'standard' })).toEqual([]);
    });

    it('maps to the model fields', () => {
        expect(anesthesiaFields({ ...booking, case_note: '  Laparoscopic cholecystectomy ' })).toEqual({
            category: 'anesthesia',
            pricing: { mode: 'fixed' },
            fixedPrice: 6000,
            caseNote: 'Laparoscopic cholecystectomy'
        });
    });
});

describe('anesthesia duty', () => {
    function run(duty) {
        return new Promise((resolve, reject) => {
            const hooks = Duty.schema.s.hooks._pres.get('save') || [];
            const totalHook = hooks.find(h => String(h.fn).includes('fixedPrice'));
            totalHook.fn.call(duty, (err) => (err ? reject(err) : resolve(duty)));
        });
    }

    it('totals the case price, not rate times hours', async () => {
        const duty = new Duty({
            staffRole: 'anesthetist', date: new Date(tomorrow), startTime: '09:00', endTime: '13:00',
            offeredRate: 1500, urgency: 'high', ...anesthesiaFields(booking)
        });
        await run(duty);
        expect(duty.totalPayment).toBe(6000);
    });

    it('keeps hourly totals for ordinary duties', async () => {
        const duty = new Duty({
            staffRole: 'nurse', date: new Date(tomorrow), startTime: '09:00', endTime: '17:00', offeredRate: 200, urgency: 'medium'
        });
        await run(duty);
        expect(duty.totalPayment).toBe(1600);
        expect(duty.category).toBe('standard');
        expect(duty.pricing.mode).toBe('hourly');
    });

    it('sends the booking fields to the doctor', () => {
        const duty = new Duty({ staffRole: 'anesthetist', date: new Date(tomorrow), startTime: '09:00', endTime: '13:00', ...anesthesiaFields(booking) });
        const json = JSON.parse(JSON.stringify(duty));
        expect(json).toMatchObject({ category: 'anesthesia', pricing: { mode: 'fixed' }, fixedPrice: 6000, caseNote: 'Laparoscopic cholecystectomy' });
        expect(duty.toObject()).toMatchObject({ category: 'anesthesia', fixedPrice: 6000 });
    });
});
