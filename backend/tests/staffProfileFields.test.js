// The doctor profile says whether the phone is verified, why verification was
// refused, and when the doctor was verified.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || 'k';
jest.mock('../src/services/cache.service', () => ({
    get: async () => null, set: async () => true, del: async () => true,
    getProfile: async () => null, setProfile: async () => true
}));
jest.mock('../src/services/s3.service', () => ({
    uploadToS3: async () => ({}), deleteFromS3: async () => true, generatePreSignedURL: async () => 'https://signed.example/x'
}));
jest.mock('../src/services/ratingAlgorithm.service', () => ({
    getEffectiveRating: async () => ({ ratingShown: null, breakdown: null })
}));

const mongoose = require('mongoose');
const User = require('../src/models/User');
const MedicalStaff = require('../src/models/MedicalStaff');
const Document = require('../src/models/Document');
const Duty = require('../src/models/Duty');
const profileService = require('../src/services/profile.service');

const lean = (value, calls) => {
    const chain = { select: (f) => { if (calls) calls.push(f); return chain; }, lean: () => chain };
    chain.then = (res, rej) => Promise.resolve(value).then(res, rej);
    return chain;
};

let staff;
let documentSelects;
beforeEach(() => {
    documentSelects = [];
    staff = {
        _id: new mongoose.Types.ObjectId(),
        fullName: 'TEST - Doctor',
        verificationStatus: 'rejected',
        rejectionReason: 'Registration number does not match',
        isPhoneVerified: true
    };
    User.findById = () => lean({ _id: 'u1', email: 'test@example.com', role: 'staff' });
    MedicalStaff.findOne = () => lean(staff);
    Document.findOne = () => lean({ documents: [{ verificationStatus: 'verified' }] }, documentSelects);
    Duty.countDocuments = async () => 0;
});

async function profile() {
    const result = await profileService.getUserProfile('u1');
    return result.profile || result;
}

describe('doctor profile fields', () => {
    it('sends the phone check and the rejection reason', async () => {
        const p = await profile();
        expect(p.isPhoneVerified).toBe(true);
        expect(p.rejectionReason).toBe('Registration number does not match');
        expect(p.verifiedAt).toBeNull();
    });

    it('sends verifiedAt and no stale reason once verified', async () => {
        const verifiedAt = new Date('2026-10-02T09:00:00Z');
        Object.assign(staff, { verificationStatus: 'verified', verifiedAt, isPhoneVerified: undefined });
        const p = await profile();
        expect(p.verifiedAt).toEqual(verifiedAt);
        expect(p.rejectionReason).toBeNull();
        expect(p.isPhoneVerified).toBe(false);
    });

    it('reads only the document fields it counts', async () => {
        await profile();
        expect(documentSelects[0]).toBe('documents.isDeleted documents.verificationStatus');
    });
});
