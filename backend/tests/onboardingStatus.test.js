// The Home checklist comes from one call: email, profile, phone, documents and review.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || 'k';
const mockCache = new Map();
jest.mock('../src/services/cache.service', () => ({
    get: async () => null, set: async () => true, del: async () => true,
    getProfileStatus: async (id) => mockCache.get(id) || null,
    setProfileStatus: async (id, value) => { mockCache.set(id, value); return true; }
}));

const User = require('../src/models/User');
const MedicalStaff = require('../src/models/MedicalStaff');
const Document = require('../src/models/Document');
const profileService = require('../src/services/profile.service');

const lean = (value, selects) => {
    const chain = { select: (f) => { if (selects) selects.push(f); return chain; }, lean: () => chain };
    chain.then = (res, rej) => Promise.resolve(value).then(res, rej);
    return chain;
};

let staff;
let docTypes;
let documentSelects;
beforeEach(() => {
    mockCache.clear();
    documentSelects = [];
    staff = { _id: 's1', isDocumentsUploaded: false, isPhoneVerified: true, verificationStatus: 'pending', profileSource: 'manual' };
    docTypes = [];
    User.findById = () => lean({ _id: 'u1', role: 'staff', isEmailVerified: true });
    MedicalStaff.findOne = () => lean(staff);
    Document.findOne = () => lean({ documents: docTypes.map(documentType => ({ documentType })) }, documentSelects);
});

const keys = (status) => status.checklist.map(c => `${c.key}:${c.done}`);

describe('onboarding status', () => {
    it('a new doctor without documents has not submitted for review', async () => {
        const status = await profileService.checkProfileCompletion('u1');
        expect(status.review).toBe('not_submitted');
        expect(status.phoneVerified).toBe(true);
        expect(keys(status)).toEqual([
            'verify_email:true', 'create_profile:true', 'verify_phone:true', 'upload_documents:false', 'verification:false'
        ]);
    });

    it('with every document uploaded the review is pending', async () => {
        staff.isDocumentsUploaded = true;
        const status = await profileService.checkProfileCompletion('u1');
        expect(status.review).toBe('pending');
        expect(status.checklist[3].done).toBe(true);
    });

    it('a rejected doctor gets the reason', async () => {
        Object.assign(staff, { isDocumentsUploaded: true, verificationStatus: 'rejected', rejectionReason: 'Degree certificate unreadable' });
        const status = await profileService.checkProfileCompletion('u1');
        expect(status.review).toBe('rejected');
        expect(status.rejectionReason).toBe('Degree certificate unreadable');
    });

    it('a verified doctor has every step done', async () => {
        Object.assign(staff, { isDocumentsUploaded: true, verificationStatus: 'verified', rejectionReason: 'old' });
        const status = await profileService.checkProfileCompletion('u1');
        expect(status.review).toBe('verified');
        expect(status.rejectionReason).toBeNull();
        expect(status.checklist.every(c => c.done)).toBe(true);
    });

    it('reads only document types, not whole documents', async () => {
        await profileService.checkProfileCompletion('u1');
        expect(documentSelects[0]).toBe('documents.documentType documents.isDeleted');
    });

    it('rebuilds a status cached before the checklist existed', async () => {
        mockCache.set('u1', { success: true, onboardingStep: 'upload_documents' });
        const status = await profileService.checkProfileCompletion('u1');
        expect(status.fromCache).toBe(false);
        expect(status.checklist).toHaveLength(5);
        expect((await profileService.checkProfileCompletion('u1')).fromCache).toBe(true);
    });
});
