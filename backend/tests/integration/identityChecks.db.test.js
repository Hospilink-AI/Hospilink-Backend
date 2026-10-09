// Identity checks and IDfy results against a real database: the projections,
// $elemMatch queries, partial indexes and conditional updates they rely on.
jest.setTimeout(180000);
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/notificationService', () => ({ createNotificationWithCount: async () => ({ unreadCount: 1 }) }));
jest.mock('../../src/services/notificationDelivery.service', () => ({ deliverToUser: async () => ({}) }));
jest.mock('../../src/services/cache.service', () => ({ invalidateProfile: async () => true }));
jest.mock('../../src/services/idfy.service', () => ({ getTaskResult: jest.fn() }));

const mongoose = require('mongoose');
const db = require('./db');
const User = require('../../src/models/User');
const MedicalStaff = require('../../src/models/MedicalStaff');
const Document = require('../../src/models/Document');
const IdentityCheck = require('../../src/models/IdentityCheck');
const identityCheck = require('../../src/services/identityCheck.service');
const idfyResults = require('../../src/services/idfyResults.service');
const idfyService = require('../../src/services/idfy.service');

async function doctor(name, documents) {
    const userId = new mongoose.Types.ObjectId();
    await db.raw(User, { _id: userId, name, email: `${userId}@test.in`, role: 'staff' });
    await db.raw(MedicalStaff, { _id: new mongoose.Types.ObjectId(), user: userId, fullName: name, email: `${userId}@test.in` });
    await db.raw(Document, { _id: new mongoose.Types.ObjectId(), userId, userRole: 'staff', documents });
    return userId;
}

const entry = (documentType, extractedData, extra = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    documentType,
    s3Key: 'k',
    fileName: 'f.jpg',
    extractedData,
    isDeleted: false,
    verificationStatus: 'manual-pending-verification',
    uploadedAt: new Date(),
    ...extra
});

beforeAll(async () => {
    await db.start();
    await Document.createIndexes();
    await IdentityCheck.createIndexes();
});
afterAll(db.stop);
beforeEach(db.clear);

test('a PAN already on another doctor is found through the partial index, and the result is stored', async () => {
    await doctor('TEST Other Person', [entry('pan-card', { name: 'TEST Other Person', panNumber: 'ABCPK1234Z' })]);
    const userId = await doctor('TEST Asha Rao', [entry('pan-card', { name: 'TEST Asha Rao', panNumber: 'ABCPK1234Z' })]);

    const check = await identityCheck.evaluate(userId);

    expect(check.status).toBe('flagged');
    expect(check.issues.map(i => i.code)).toContain('DUPLICATE_PAN');
    const stored = await IdentityCheck.findOne({ user: userId }).lean();
    expect(stored.severity).toBe('high');
    expect(stored.reminders.count).toBe(1);
});

test('the IDfy job finds a waiting PAN check and applies the result once', async () => {
    const requestId = 'req-test-1';
    const userId = await doctor('TEST Asha Rao', [
        entry('pan-card', { name: 'TEST Asha Rao', panNumber: 'ABCPK1234Z' }, {
            verificationMeta: { provider: 'idfy', status: 'in_progress', requestId }
        })
    ]);
    idfyService.getTaskResult.mockResolvedValue([{ status: 'completed', result: { source_output: { status: 'id_found' } } }]);

    const first = await idfyResults.checkPending();
    const second = await idfyResults.checkPending();

    expect(first).toEqual({ checked: 1, settled: 1 });
    expect(second).toEqual({ checked: 0, settled: 0 });
    const record = await Document.findOne({ userId }).lean();
    expect(record.documents[0].verificationStatus).toBe('auto-verified');
    expect(record.documents[0].verificationMeta.status).toBe('completed');
});
