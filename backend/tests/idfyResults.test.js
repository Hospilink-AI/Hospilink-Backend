// IDfy PAN / GST / CIN results are fetched by a job, not a timer inside one
// server, so a deploy or a second server can't lose or double-apply them
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/cache.service', () => ({ invalidateProfile: jest.fn(async () => true) }));
jest.mock('../src/services/idfy.service', () => ({ getTaskResult: jest.fn() }));

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Document = require('../src/models/Document');
const idfyService = require('../src/services/idfy.service');
const cacheService = require('../src/services/cache.service');
const idfyResults = require('../src/services/idfyResults.service');

const userId = new mongoose.Types.ObjectId();
let record;
let updates;
let lastFind;

function entry(overrides = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        documentType: 'pan-card',
        isDeleted: false,
        verificationStatus: 'manual-pending-verification',
        uploadedAt: new Date(),
        verificationMeta: { provider: 'idfy', status: 'in_progress', requestId: 'req-1' },
        ...overrides
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    updates = [];
    record = { _id: new mongoose.Types.ObjectId(), userId, userRole: 'hospital', documents: [entry()] };
    const chain = (value) => {
        const c = { select: () => c, limit: () => c, lean: async () => value };
        return c;
    };
    Document.find = (filter) => { lastFind = filter; return chain([record]); };
    Document.findOne = () => chain(record);
    Document.updateOne = async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; };
});

test('a completed PAN check verifies the document', async () => {
    idfyService.getTaskResult.mockResolvedValue([{ status: 'completed', result: { source_output: { status: 'id_found' } } }]);
    const result = await idfyResults.checkPending();
    expect(result).toEqual({ checked: 1, settled: 1 });
    const set = updates[0].update.$set;
    expect(set['documents.$.verificationStatus']).toBe('auto-verified');
    expect(set['documents.$.verificationMeta.status']).toBe('completed');
    expect(cacheService.invalidateProfile).toHaveBeenCalledWith(String(userId), 'hospital');
});

test('a completed check that does not match rejects, as before', async () => {
    record.documents = [entry({ documentType: 'gst-certificate' })];
    idfyService.getTaskResult.mockResolvedValue([{ status: 'completed', result: { source_output: { gstin_status: 'Cancelled' } } }]);
    await idfyResults.checkPending();
    expect(updates[0].update.$set['documents.$.verificationStatus']).toBe('rejected');
});

test('a failed check goes to an admin', async () => {
    idfyService.getTaskResult.mockResolvedValue([{ status: 'failed' }]);
    await idfyResults.checkPending();
    const set = updates[0].update.$set;
    expect(set['documents.$.verificationStatus']).toBe('manual-pending-verification');
    expect(set['documents.$.verificationMeta.status']).toBe('failed');
});

test('no answer yet: nothing changes, it is checked again next minute', async () => {
    idfyService.getTaskResult.mockResolvedValue([{ status: 'in_progress' }]);
    expect(await idfyResults.checkPending()).toEqual({ checked: 1, settled: 0 });
    expect(updates).toHaveLength(0);
});

test('no answer after a day: it stops waiting and goes to an admin', async () => {
    record.documents = [entry({ uploadedAt: new Date(Date.now() - idfyResults.GIVE_UP_AFTER_MS - 1000) })];
    idfyService.getTaskResult.mockResolvedValue(null);
    await idfyResults.checkPending();
    expect(updates[0].update.$set['documents.$.verificationMeta.status']).toBe('timed_out');
});

test('a document an admin already decided is left alone', async () => {
    record.documents = [entry({ verificationStatus: 'verified' })];
    expect(await idfyResults.checkPending()).toEqual({ checked: 0, settled: 0 });
    expect(idfyService.getTaskResult).not.toHaveBeenCalled();
    // And the database update itself refuses a decided entry
    record.documents = [entry()];
    idfyService.getTaskResult.mockResolvedValue([{ status: 'completed', result: { source_output: { status: 'id_found' } } }]);
    await idfyResults.checkPending();
    const match = updates[0].filter.documents.$elemMatch;
    expect(match['verificationMeta.status']).toBe('in_progress');
    expect(match.verificationStatus.$in).toEqual(['pending', 'manual-pending-verification']);
});

test('the query uses the partial index', async () => {
    idfyService.getTaskResult.mockResolvedValue(null);
    await idfyResults.checkPending();
    expect(lastFind['documents.verificationMeta.status']).toBe('in_progress');
    const index = Document.schema.indexes().find(([keys]) => keys['documents.verificationMeta.status'] === 1);
    expect(index[1].partialFilterExpression).toEqual({ 'documents.verificationMeta.status': 'in_progress' });
});

test('the early check finds the upload by request id', async () => {
    jest.useFakeTimers();
    idfyService.getTaskResult.mockResolvedValue([{ status: 'completed', result: { source_output: { status: 'id_found' } } }]);
    idfyResults.checkSoon(userId, 'req-1', 1000);
    await jest.advanceTimersByTimeAsync(1000);
    jest.useRealTimers();
    expect(updates).toHaveLength(1);
});

test('the upload no longer starts a timer in the web server, and a job runs every minute', () => {
    const service = fs.readFileSync(path.join(__dirname, '../src/services/document.service.js'), 'utf8');
    expect(service).not.toContain('processIdfyResultAsync');
    expect(service).not.toContain('setInterval');
    const cron = fs.readFileSync(path.join(__dirname, '../src/utils/cronJobs.js'), 'utf8');
    expect(cron).toContain("acquireCronLock('idfy-results', 55)");
});

test('IDfy calls have a time limit', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/idfy.service.js'), 'utf8');
    expect(source.match(/timeout: REQUEST_TIMEOUT_MS/g)).toHaveLength(5);
    expect(source).not.toContain('err.response?.data');
});
