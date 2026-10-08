// The three staff middlewares share one cache key. A call through one of them
// must never leave an entry that makes another refuse a doctor by mistake.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const mockStore = new Map();
jest.mock('../src/services/cache.service', () => ({
    get: async (key) => (mockStore.has(key) ? JSON.parse(mockStore.get(key)) : null),
    set: async (key, value) => { mockStore.set(key, JSON.stringify(value)); return true; },
    del: async (key) => { mockStore.delete(key); return true; }
}));

const MedicalStaff = require('../src/models/MedicalStaff');
const middleware = require('../src/middleware/accountsVerification.middleware');

let staffDoc;
let dbReads;
beforeEach(() => {
    mockStore.clear();
    dbReads = 0;
    staffDoc = { verificationStatus: 'verified', rejectionReason: null, isAvailable: true };
    MedicalStaff.findOne = () => ({ select: () => ({ lean: async () => { dbReads++; return staffDoc; } }) });
});

function run(mw) {
    return new Promise((resolve) => {
        const req = { user: { _id: 'u1', role: 'staff' } };
        mw(req, {}, (err) => resolve({ err, req }));
    });
}

describe('staff verification cache', () => {
    it('a verified-only call does not make the next feed call say availability is off', async () => {
        expect((await run(middleware.requireVerifiedStaffOnly)).err).toBeUndefined();
        const { err } = await run(middleware.requireStaffVerificationandisAvailable);
        expect(err).toBeUndefined();
        expect(dbReads).toBe(1);
    });

    it('a strict verified call does not break the other two', async () => {
        expect((await run(middleware.requireVerifiedStaff)).err).toBeUndefined();
        expect((await run(middleware.requireStaffVerificationandisAvailable)).err).toBeUndefined();
        expect((await run(middleware.requireVerifiedStaffOnly)).err).toBeUndefined();
        expect(dbReads).toBe(1);
    });

    it('treats an entry in an old partial shape as a miss', async () => {
        mockStore.set('staff_verification:u1', JSON.stringify({ verificationStatus: 'verified', rejectionReason: null }));
        expect((await run(middleware.requireStaffVerificationandisAvailable)).err).toBeUndefined();
        mockStore.set('staff_verification:u1', JSON.stringify({ status: 'verified' }));
        expect((await run(middleware.requireStaffVerificationandisAvailable)).err).toBeUndefined();
        expect(dbReads).toBe(2);
    });

    it('still refuses when availability is really off', async () => {
        staffDoc.isAvailable = false;
        const { err } = await run(middleware.requireStaffVerificationandisAvailable);
        expect(err && err.message).toMatch(/availability is currently OFF/);
        expect((await run(middleware.requireVerifiedStaffOnly)).err).toBeUndefined();
    });

    it('still refuses a doctor who is not verified', async () => {
        staffDoc.verificationStatus = 'pending';
        expect((await run(middleware.requireVerifiedStaff)).err).toBeTruthy();
        expect((await run(middleware.requireVerifiedStaffOnly)).err).toBeTruthy();
    });

    it('keeps status on req.staffVerification for older readers', async () => {
        const { req } = await run(middleware.requireVerifiedStaff);
        expect(req.staffVerification.status).toBe('verified');
    });
});
