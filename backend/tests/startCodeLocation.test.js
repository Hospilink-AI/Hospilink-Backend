// A doctor who just opened the app at the desk has no live position yet. The
// app may send its coordinates with the start code calls, and the server uses
// them when the live position is missing or stale. The geofence stays the same.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));
jest.mock('../src/services/sms.service', () => ({ sendOTPSMS: jest.fn(async () => true) }));

const mongoose = require('mongoose');
const Duty = require('../src/models/Duty');
const MedicalStaff = require('../src/models/MedicalStaff');
const DashboardService = require('../src/services/dashboard.service');
const DutyService = require('../src/services/duty.service');
const { validateRequestStartOtp, validateVerifyStartOtp } = require('../src/middleware/validation.middleware');

const HOSPITAL = { latitude: 18.5204, longitude: 73.8567 };
const AT_DESK = { latitude: 18.5205, longitude: 73.8568 };
const FAR_AWAY = { latitude: 18.6, longitude: 73.9 };

function validate(mw, body) {
    let status = 200;
    let payload = null;
    let passed = false;
    const res = { status: (s) => { status = s; return res; }, json: (p) => { payload = p; return res; } };
    mw({ body }, res, () => { passed = true; });
    return { passed, status, payload };
}

describe('start code validators', () => {
    it('accept no body, as before', () => {
        expect(validate(validateRequestStartOtp, {}).passed).toBe(true);
        expect(validate(validateVerifyStartOtp, { otp: '123456' }).passed).toBe(true);
    });

    it('accept coordinates', () => {
        expect(validate(validateRequestStartOtp, AT_DESK).passed).toBe(true);
        expect(validate(validateVerifyStartOtp, { otp: '123456', ...AT_DESK }).passed).toBe(true);
    });

    it.each([
        [{ latitude: 18.5 }],
        [{ latitude: '18.5', longitude: 73.8 }],
        [{ latitude: 91, longitude: 73.8 }],
        [{ latitude: 18.5, longitude: -181 }],
        [{ latitude: 18.5, longitude: 73.8, accuracy: 5 }]
    ])('refuse %j', (body) => {
        const result = validate(validateRequestStartOtp, body);
        expect(result.passed).toBe(false);
        expect(result.status).toBe(400);
    });
});

describe('requesting the start code', () => {
    const staffId = new mongoose.Types.ObjectId();
    let duty;
    let liveLocation;

    beforeEach(() => {
        liveLocation = null;
        // Starts now, so the check-in window is open
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        duty = {
            _id: new mongoose.Types.ObjectId(),
            assignedTo: staffId,
            status: 'enroute',
            startOtp: { status: 'NONE' },
            // the service converts the stored date to IST before setting the time
            date: new Date(start.getTime() - 5.5 * 60 * 60 * 1000),
            startTime: `${hh}:${mm}`,
            hospital: { phoneNumber: '+910000000000', coordinates: { coordinates: HOSPITAL } }
        };
        MedicalStaff.findOne = async () => ({ _id: staffId });
        Duty.findById = () => {
            const chain = { select: () => chain, populate: async () => duty };
            return chain;
        };
        Duty.findOneAndUpdate = async () => ({ startOtp: { expiresAt: new Date(Date.now() + 300000) } });
        DashboardService.getDashboardLocation = async () => liveLocation;
    });


    it('uses the coordinates sent when there is no live position', async () => {
        const result = await DutyService.requestStartOtp(duty._id, 'u1', AT_DESK);
        expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('still refuses without any position', async () => {
        await expect(DutyService.requestStartOtp(duty._id, 'u1')).rejects.toThrow('Unable to determine your current location');
    });

    it('still checks the geofence against the coordinates sent', async () => {
        await expect(DutyService.requestStartOtp(duty._id, 'u1', FAR_AWAY)).rejects.toThrow(/within \d+m of the hospital/);
    });

    it('prefers a fresh live position', async () => {
        liveLocation = { ...FAR_AWAY, updatedAt: new Date().toISOString() };
        await expect(DutyService.requestStartOtp(duty._id, 'u1', AT_DESK)).rejects.toThrow(/within \d+m of the hospital/);
    });

    it('ignores a stale live position', async () => {
        liveLocation = { ...FAR_AWAY, updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
        const result = await DutyService.requestStartOtp(duty._id, 'u1', AT_DESK);
        expect(result.expiresAt).toBeInstanceOf(Date);
    });
});
