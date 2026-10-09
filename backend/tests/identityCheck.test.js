// Comparing a user's identity documents with each other and their profile:
// admin-only flags, reminders to the user, and the auto-verify decisions
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockNotices = [];
jest.mock('../src/services/notificationService', () => ({
    createNotificationWithCount: async (userId, type, payload) => { mockNotices.push({ userId, type, payload }); return { unreadCount: 1 }; }
}));
jest.mock('../src/services/notificationDelivery.service', () => ({ deliverToUser: async () => ({}) }));

const mongoose = require('mongoose');
const IdentityCheck = require('../src/models/IdentityCheck');
const Document = require('../src/models/Document');
const MedicalStaff = require('../src/models/MedicalStaff');
const Hospital = require('../src/models/Hospital');
const User = require('../src/models/User');
const service = require('../src/services/identityCheck.service');

const userId = new mongoose.Types.ObjectId();
let role;
let fullName;
let hospitalLegalName;
let documents;
let duplicateOwner;
let store;

const chain = (value) => {
    const c = { select: () => c, lean: async () => value, limit: () => c, sort: () => c, skip: () => c, populate: () => c };
    return c;
};

function doc(documentType, extractedData, extra = {}) {
    return { documentType, extractedData, isDeleted: false, verificationStatus: 'pending', uploadedAt: new Date(), ...extra };
}

beforeEach(() => {
    mockNotices.length = 0;
    role = 'staff';
    fullName = 'Jeet Kolhe';
    hospitalLegalName = 'Sai Hospital';
    documents = [];
    duplicateOwner = null;
    store = null;
    User.findById = () => chain({ _id: userId, role });
    MedicalStaff.findOne = () => chain({ fullName });
    Hospital.findOne = () => chain({ hospitalLegalName });
    Document.findOne = (filter) => {
        if (filter.userId && filter.userId.$ne) return chain(duplicateOwner ? { userId: duplicateOwner } : null);
        return chain({ documents });
    };
    IdentityCheck.findOne = () => chain(store);
    IdentityCheck.findOneAndUpdate = (filter, update) => {
        if (filter._id) {
            store = { ...store, ...update.$set };
        } else {
            store = { _id: 'c1', user: userId, ...(store || {}), ...update.$set };
        }
        return Promise.resolve(store);
    };
});

describe('doctors', () => {
    it('is clear when every document names the same person', async () => {
        documents = [
            doc('aadhaar-card', { name: 'Jeet Ramesh Kolhe', dob: '12/05/1990' }),
            doc('pan-card', { name: 'KOLHE JEET RAMESH', dob: '12/05/1990', panNumber: 'ABCPK1234Z' }),
            doc('license-permit', { name: 'Dr. Jeet Kolhe', licenseNumber: 'I-12345-A' }),
            doc('mcim-certificate', { doctorName: 'Dr. Jeet Kolhe', registrationNumber: 'I-12345-A' })
        ];
        const check = await service.evaluate(userId);
        expect(check.status).toBe('clear');
        expect(check.issues).toEqual([]);
        expect(check.comparisons.length).toBeGreaterThanOrEqual(5);
        expect(mockNotices).toHaveLength(0);
    });

    it('flags another person\'s PAN, reminds the user once, without saying what was found', async () => {
        documents = [doc('pan-card', { name: 'Rasika Kolhe', dob: '01/01/1992', panNumber: 'ABCPK1234Z' })];
        const check = await service.evaluate(userId);
        expect(check.status).toBe('flagged');
        expect(check.severity).toBe('high');
        expect(check.issues[0]).toMatchObject({ code: 'NAME_MISMATCH', source: 'profile', against: 'pan-card', againstValue: 'Rasika Kolhe' });
        expect(mockNotices).toHaveLength(1);
        expect(mockNotices[0].type).toBe('IDENTITY_DETAILS_MISMATCH');
        expect(mockNotices[0].payload.message).not.toMatch(/flag|Rasika|PAN number/i);

        // Same difference on the next check: no second immediate notice
        await service.evaluate(userId);
        expect(mockNotices).toHaveLength(1);
    });

    it('flags different dates of birth across documents', async () => {
        documents = [
            doc('aadhaar-card', { name: 'Jeet Kolhe', dob: '12/05/1990' }),
            doc('pan-card', { name: 'Jeet Kolhe', dob: '12/05/1991' })
        ];
        const check = await service.evaluate(userId);
        expect(check.issues.map(i => i.code)).toEqual(['DOB_MISMATCH']);
        expect(check.severity).toBe('high');
    });

    it('a close name or different licence number is flagged for admins only, without a reminder', async () => {
        fullName = 'Jeet';
        documents = [
            doc('aadhaar-card', { name: 'Jeet Kolhe' }),
            doc('license-permit', { name: 'Jeet Kolhe', licenseNumber: 'I-111-A' }),
            doc('mcim-certificate', { doctorName: 'Jeet Kolhe', registrationNumber: 'I-222-A' })
        ];
        const check = await service.evaluate(userId);
        expect(check.status).toBe('flagged');
        expect(check.severity).toBe('low');
        expect(check.issues.map(i => i.code).sort()).toEqual(['NAME_PARTIAL', 'NAME_PARTIAL', 'NAME_PARTIAL', 'NUMBER_MISMATCH']);
        expect(mockNotices).toHaveLength(0);
    });

    it('never flags what OCR could not read, nor deleted or rejected documents', async () => {
        documents = [
            doc('pan-card', { name: 'INCOME TAX DEPARTMENT', dob: null }),
            doc('aadhaar-card', { name: 'Rasika Kolhe' }, { isDeleted: true }),
            doc('license-permit', { name: 'Rasika Kolhe' }, { verificationStatus: 'rejected' })
        ];
        const check = await service.evaluate(userId);
        expect(check.status).toBe('clear');
    });

    it('flags a PAN already on another doctor\'s account, masked', async () => {
        documents = [doc('pan-card', { name: 'Jeet Kolhe', panNumber: 'ABCPK1234Z' })];
        duplicateOwner = new mongoose.Types.ObjectId();
        const check = await service.evaluate(userId);
        const issue = check.issues.find(i => i.code === 'DUPLICATE_PAN');
        expect(issue).toMatchObject({ severity: 'high', sourceValue: '*****1234Z', otherUserId: duplicateOwner });
    });

    it('an admin dismissal holds until the differences change', async () => {
        documents = [doc('pan-card', { name: 'Rasika Kolhe' })];
        await service.evaluate(userId);
        const dismissed = await service.dismiss(userId, 'admin1', 'Name changed after marriage');
        expect(dismissed.status).toBe('dismissed');

        await service.evaluate(userId);
        expect(store.status).toBe('dismissed');

        documents = [doc('pan-card', { name: 'Vikram Singh' })];
        await service.evaluate(userId);
        expect(store.status).toBe('flagged');
        expect(mockNotices).toHaveLength(2);
    });

    it('clears once the details agree', async () => {
        documents = [doc('pan-card', { name: 'Rasika Kolhe' })];
        await service.evaluate(userId);
        documents = [doc('pan-card', { name: 'Jeet Kolhe' })];
        const check = await service.evaluate(userId);
        expect(check.status).toBe('clear');
        expect(check.reminders.count).toBe(0);
    });
});

describe('hospitals', () => {
    beforeEach(() => { role = 'hospital'; });

    it('compares the signer\'s Aadhaar with their own PAN, not with the hospital name', async () => {
        documents = [
            doc('aadhaar-card', { name: 'Asha Rao', dob: '01/02/1980' }),
            doc('pan-card', { name: 'Vikram Singh', dob: '01/02/1980', panNumber: 'ABCPK1234Z' })
        ];
        const check = await service.evaluate(userId);
        expect(check.issues.map(i => i.code)).toEqual(['NAME_MISMATCH']);
        expect(check.issues[0]).toMatchObject({ source: 'aadhaar-card', against: 'pan-card' });
    });

    it('skips a company PAN and compares the company names (admins only)', async () => {
        documents = [
            doc('aadhaar-card', { name: 'Asha Rao' }),
            doc('pan-card', { name: 'SAI HOSPITAL PVT LTD', panNumber: 'ABCCK1234Z' }),
            doc('gst-certificate', { legalName: 'SAI HOSPITAL PRIVATE LIMITED', tradeName: 'Sai Hospital' }),
            doc('cin-certificate', { businessName: 'LOTUS DIAGNOSTICS PRIVATE LIMITED' })
        ];
        const check = await service.evaluate(userId);
        expect(check.issues.map(i => i.code)).toEqual(['COMPANY_NAME_MISMATCH']);
        expect(check.severity).toBe('low');
        expect(mockNotices).toHaveLength(0);
    });
});

describe('auto-verification decisions', () => {
    it('verifies a DigiLocker Aadhaar only when the name matches the profile', async () => {
        expect(await service.aadhaarDecision(userId, 'staff', { name: 'Jeet Ramesh Kolhe' })).toEqual({ autoVerify: true, reason: null });
        expect(await service.aadhaarDecision(userId, 'staff', { name: 'Rasika Kolhe' })).toEqual({ autoVerify: false, reason: 'name_mismatch' });
        expect(await service.aadhaarDecision(userId, 'staff', { full_name: 'Sunita Jeet Kolhe' })).toEqual({ autoVerify: false, reason: 'name_partial' });
        expect(await service.aadhaarDecision(userId, 'staff', {})).toEqual({ autoVerify: false, reason: 'name_unreadable' });
    });

    it('sends an Aadhaar whose date of birth differs from the PAN to an admin', async () => {
        documents = [doc('pan-card', { name: 'Jeet Kolhe', dob: '12/05/1991' })];
        expect(await service.aadhaarDecision(userId, 'staff', { name: 'Jeet Kolhe', dob: '1990-05-12' }))
            .toEqual({ autoVerify: false, reason: 'dob_mismatch' });
    });

    it('verifies a found PAN only when the card name matches the profile', async () => {
        expect(await service.panDecision(userId, 'staff', 'KOLHE JEET RAMESH')).toEqual({ autoVerify: true, reason: null });
        expect(await service.panDecision(userId, 'staff', 'RASIKA KOLHE')).toEqual({ autoVerify: false, reason: 'name_mismatch' });
        expect((await service.panDecision(userId, 'hospital', 'ANYONE')).autoVerify).toBe(true);
    });
});

describe('reminders', () => {
    it('sends the day-3 and day-7 reminders once each, for serious flags only', async () => {
        const due = [{ _id: 'c1', user: userId, role: 'staff' }];
        const claimed = [];
        IdentityCheck.find = (filter) => chain(filter['reminders.count'] === 1 ? due : []);
        IdentityCheck.updateOne = async (filter, update) => {
            claimed.push({ filter, update });
            return { modifiedCount: 1 };
        };
        const sent = await service.sendDueReminders(new Date());
        expect(sent).toBe(1);
        expect(claimed[0].filter['reminders.count']).toBe(1);
        expect(claimed[0].update.$set['reminders.count']).toBe(2);
        expect(mockNotices).toHaveLength(1);
        expect(service.REMINDER_DAYS).toEqual([0, 3, 7]);
    });
});

describe('admin views', () => {
    it('adds a summary to each list row by user id', async () => {
        const other = new mongoose.Types.ObjectId();
        IdentityCheck.find = () => chain([{ user: userId, status: 'flagged', severity: 'high', issues: [{ code: 'NAME_MISMATCH' }], checkedAt: new Date() }]);
        const rows = [{ userId }, { user: { id: other } }];
        await service.attachSummaries(rows);
        expect(rows[0].identityCheck).toMatchObject({ status: 'flagged', severity: 'high', issueCount: 1 });
        expect(rows[1].identityCheck).toBeNull();
    });

    it('labels the documents in the detail view and checks an account never checked', async () => {
        documents = [doc('pan-card', { name: 'Rasika Kolhe' })];
        const detail = await service.forAdmin(userId);
        expect(detail.issues[0]).toMatchObject({ sourceLabel: 'Profile', againstLabel: 'PAN' });
    });
});

describe('privacy', () => {
    it('keeps the result out of the profile documents doctors and hospitals read', () => {
        expect(MedicalStaff.schema.path('identityCheck')).toBeUndefined();
        expect(Hospital.schema.path('identityCheck')).toBeUndefined();
        expect(IdentityCheck.collection.collectionName).toBe('identitychecks');
    });
});

describe('admin routes', () => {
    it('are for admins only: viewing needs document.view, dismissing document.manage', () => {
        const fs = require('fs');
        const path = require('path');
        const routes = fs.readFileSync(path.join(__dirname, '../src/routes/adminIdentityChecks.routes.js'), 'utf8');
        expect(routes).toContain("router.use(protect);");
        expect(routes).toContain("router.use(authorize('admin'));");
        expect(routes).toContain("router.post('/:userId/dismiss', requireCapability('document.manage'), controller.dismiss);");
        const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
        expect(app).toContain('app.use("/api/admin/identity-checks", require("./routes/adminIdentityChecks.routes"));');
    });
});
