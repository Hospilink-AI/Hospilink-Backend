// A doctor sees why a document was rejected and when one was verified.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || 'k';
jest.mock('../src/services/s3.service', () => ({
    uploadToS3: async () => ({}), deleteFromS3: async () => true,
    generatePreSignedURL: async (key) => `https://signed.example/${key}`
}));

const mongoose = require('mongoose');
const Document = require('../src/models/Document');
const documentService = require('../src/services/document.service');

const verifiedAt = new Date('2026-10-01T10:00:00Z');
let selected;

beforeEach(() => {
    selected = null;
    const record = {
        documents: [
            { _id: new mongoose.Types.ObjectId(), documentType: 'mbbs_degree', verificationStatus: 'rejected', rejectionReason: 'The photo is blurred', s3Key: 'a', fileName: 'a.pdf' },
            { _id: new mongoose.Types.ObjectId(), documentType: 'aadhaar', verificationStatus: 'verified', verifiedAt, rejectionReason: 'old reason', s3Key: 'b', fileName: 'b.pdf' },
            { _id: new mongoose.Types.ObjectId(), documentType: 'pan', verificationStatus: 'pending', s3Key: 'c', fileName: 'c.pdf' },
            { _id: new mongoose.Types.ObjectId(), documentType: 'old', verificationStatus: 'pending', s3Key: 'd', isDeleted: true }
        ]
    };
    Document.findOne = () => {
        const chain = {
            select: (fields) => { selected = fields; return chain; },
            lean: () => chain,
            then: (res, rej) => Promise.resolve(record).then(res, rej)
        };
        return chain;
    };
});

describe('document list', () => {
    it('returns the rejection reason for a rejected document', async () => {
        const { documents } = await documentService.getUserDocuments({ _id: 'u1' }, { page: 1, limit: 10 });
        expect(documents).toHaveLength(3);
        expect(documents[0].rejectionReason).toBe('The photo is blurred');
        expect(documents[0].verifiedAt).toBeNull();
    });

    it('returns verifiedAt, and no stale reason, for a verified document', async () => {
        const { documents } = await documentService.getUserDocuments({ _id: 'u1' }, { page: 1, limit: 10 });
        expect(documents[1].verifiedAt).toEqual(verifiedAt);
        expect(documents[1].rejectionReason).toBeNull();
        expect(documents[2].rejectionReason).toBeNull();
    });

    it('leaves the provider response out of the read', async () => {
        await documentService.getUserDocuments({ _id: 'u1' }, {});
        expect(selected).toContain('-documents.verificationMeta.rawResponse');
    });
});
