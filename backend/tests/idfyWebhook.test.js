jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({ invalidateProfile: async () => true }));
const mockVerifiedNotices = [];
jest.mock('../src/services/notificationEmitter', () => ({
    emitDocumentAutoVerified: async (userId) => { mockVerifiedNotices.push(userId); }
}));
jest.mock('../src/services/activityLogEmitter', () => ({ emitDocumentActivity: async () => {} }));

const Document = require('../src/models/Document');
const { handleAadhaarWebhook } = require('../src/controllers/webhook.controller');

let updates;
beforeAll(() => { process.env.IDFY_WEBHOOK_TOKEN = 'secret-token'; });
beforeEach(() => {
    updates = [];
    mockVerifiedNotices.length = 0;
    Document.updateOne = async (q, u) => { updates.push(u.$set); return { modifiedCount: 1 }; };
    Document.findOne = () => ({ select: () => ({ lean: async () => ({ userId: 'u1', userRole: 'staff' }) }) });
});

async function send(body) {
    const res = { code: null, status(c) { this.code = c; return this; }, json() { return this; } };
    await handleAadhaarWebhook({ query: { wt: 'secret-token' }, body, ip: '1.1.1.1' }, res);
    return res.code;
}
const details = { name: 'Asha Rao', aadhaarNumber: 'XXXX-XXXX-1234' };

describe('IDfy Aadhaar webhook', () => {
    it('auto-verifies only a clear success that carries the details', async () => {
        expect(await send({ reference_id: 'r1', status: 'Completed', parsed_details: details })).toBe(200);
        expect(updates[0]['documents.$.verificationStatus']).toBe('auto-verified');
        expect(mockVerifiedNotices).toEqual(['u1']);
    });

    it.each([
        ['failed', { status: 'failed', parsed_details: details }],
        ['in progress', { status: 'in_progress', parsed_details: details }],
        ['expired', { status: 'expired' }],
        ['no status', { parsed_details: details }],
        ['success without details', { status: 'completed', parsed_details: {} }],
        ['an unknown new status', { status: 'consent_denied', parsed_details: details }]
    ])('sends %s to manual review', async (_, payload) => {
        await send({ reference_id: 'r1', ...payload });
        expect(updates[0]['documents.$.verificationStatus']).toBe('manual-pending-verification');
        expect(updates[0]['documents.$.verificationMeta.status']).toBe(payload.status || 'unknown');
        expect(mockVerifiedNotices).toEqual([]);
    });

    it('still rejects a wrong token', async () => {
        const res = { code: null, status(c) { this.code = c; return this; }, json() { return this; } };
        await handleAadhaarWebhook({ query: { wt: 'wrong-token!' }, body: { reference_id: 'r1', status: 'completed' } }, res);
        expect(res.code).toBe(401);
        expect(updates).toEqual([]);
    });
});
