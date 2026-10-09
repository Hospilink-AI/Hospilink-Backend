// An optional date of birth on the doctor's profile: validated, hidden from
// everyone but the doctor, and compared with the identity documents
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/notificationService', () => ({ createNotificationWithCount: async () => ({ unreadCount: 1 }) }));
jest.mock('../src/services/notificationDelivery.service', () => ({ deliverToUser: async () => ({}) }));
process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || 'test-key';

const mongoose = require('mongoose');
const { validateProfileUpdate, validateMedicalStaffProfile } = require('../src/middleware/validation.middleware');
const MedicalStaff = require('../src/models/MedicalStaff');
const IdentityCheck = require('../src/models/IdentityCheck');
const Document = require('../src/models/Document');
const User = require('../src/models/User');
const profileService = require('../src/services/profile.service');
const identityCheck = require('../src/services/identityCheck.service');

function validate(middleware, body) {
    let status = null;
    let payload = null;
    const res = { status(s) { status = s; return this; }, json(b) { payload = b; return this; } };
    let passed = false;
    middleware({ body, user: { role: 'staff', email: 'a@test.in' } }, res, () => { passed = true; });
    return { passed, status, message: JSON.stringify(payload || '') };
}

describe('validation', () => {
    it('accepts a real date for an adult, or nothing', () => {
        expect(validate(validateProfileUpdate, { dateOfBirth: '1990-05-12' }).passed).toBe(true);
        expect(validate(validateProfileUpdate, { dateOfBirth: null }).passed).toBe(true);
        expect(validate(validateProfileUpdate, {}).passed).toBe(true);
    });

    it.each([
        ['12/05/1990', /YYYY-MM-DD/],
        ['1990-02-30', /YYYY-MM-DD/],
        [`${new Date().getFullYear() - 10}-01-01`, /between 18 and 80/],
        ['1900-01-01', /between 18 and 80/]
    ])('refuses %s', (value, message) => {
        const result = validate(validateProfileUpdate, { dateOfBirth: value });
        expect(result.passed).toBe(false);
        expect(result.message).toMatch(message);
    });

    it('is allowed when the profile is created', () => {
        const body = { fullName: 'Jeet Kolhe', jobRole: 'rmo', currentAddress: 'Kothrud', city: 'Pune', state: 'Maharashtra',
            pincode: '411038', phoneNumber: '9876543210', email: 'a@test.in', experience: '1-3 years', dateOfBirth: '1990-05-12' };
        const result = validate(validateMedicalStaffProfile, body);
        expect(result.message).not.toMatch(/Unexpected fields/);
        expect(result.message).not.toMatch(/Date of birth/);
        expect(() => validate(validateMedicalStaffProfile, { ...body, dateOfBirth: '2020-01-01' })).toThrow(/between 18 and 80/);
    });
});

describe('privacy', () => {
    it('is never returned unless asked for', () => {
        expect(MedicalStaff.schema.path('dateOfBirth').options.select).toBe(false);
    });

    it('is editable through the profile update', () => {
        expect(profileService.EDITABLE_PROFILE_FIELDS.staff).toContain('dateOfBirth');
        expect(profileService.EDITABLE_PROFILE_FIELDS.hospital).not.toContain('dateOfBirth');
    });
});

describe('identity checks', () => {
    const userId = new mongoose.Types.ObjectId();
    let profile;
    let documents;
    let store;
    const chain = (value) => { const c = { select: () => c, lean: async () => value }; return c; };

    beforeEach(() => {
        profile = { fullName: 'Jeet Kolhe', dateOfBirth: new Date(Date.UTC(1990, 4, 12)) };
        documents = [];
        store = null;
        User.findById = () => chain({ _id: userId, role: 'staff' });
        MedicalStaff.findOne = () => chain(profile);
        Document.findOne = () => chain({ documents });
        IdentityCheck.findOne = () => chain(store);
        IdentityCheck.findOneAndUpdate = (filter, update) => { store = { ...(store || {}), ...update.$set }; return Promise.resolve(store); };
    });

    it('flags a document whose date of birth differs from the profile', async () => {
        documents = [{ documentType: 'pan-card', extractedData: { name: 'Jeet Kolhe', dob: '12/05/1991' }, uploadedAt: new Date() }];
        const check = await identityCheck.evaluate(userId);
        expect(check.issues).toEqual([expect.objectContaining({ code: 'DOB_MISMATCH', source: 'profile', against: 'pan-card' })]);
    });

    it('agrees with a matching document', async () => {
        documents = [{ documentType: 'aadhaar-card', extractedData: { name: 'Jeet Kolhe', dob: '12/05/1990' }, uploadedAt: new Date() }];
        expect((await identityCheck.evaluate(userId)).status).toBe('clear');
    });

    it('holds back Aadhaar auto-verification when the date of birth differs', async () => {
        expect(await identityCheck.aadhaarDecision(userId, 'staff', { name: 'Jeet Kolhe', dob: '1991-05-12' }))
            .toEqual({ autoVerify: false, reason: 'dob_mismatch' });
        expect((await identityCheck.aadhaarDecision(userId, 'staff', { name: 'Jeet Kolhe', dob: '1990-05-12' })).autoVerify).toBe(true);
    });
});
