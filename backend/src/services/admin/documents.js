// Admin: uploaded documents
// Methods of AdminService; mixed into the class in ../admin.service.js, so `this` is the service.
const Document = require('../../models/Document');
const { generatePreSignedURL } = require('../s3.service');
const { getPaginationParams, getPaginationMeta } = require('../../utils/pagination');
const { maskedExtractedData } = require('../../utils/aadhaarMask');

module.exports = {
    // GET /api/admin/documents — paginated list of all documents across all users
    async getAllDocuments({ status, userRole, page = 1, limit = 10, sortBy = 'uploadedAt', sortOrder = 'desc' }) {
        const { skip } = getPaginationParams(page, limit);

        // Build match on subdocument fields
        const docMatch = { 'documents.isDeleted': false };
        if (status) docMatch['documents.verificationStatus'] = status;

        const roleMatch = {};
        if (userRole) roleMatch.userRole = userRole;

        const sortDir = sortOrder === 'asc' ? 1 : -1;

        // Unwind documents, filter, lookup user name, paginate
        const pipeline = [
            { $match: roleMatch },
            { $unwind: '$documents' },
            { $match: docMatch },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'userInfo'
                }
            },
            { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
            {
                // Add a numeric priority field: pending/manual-pending = 0, everything else = 1
                $addFields: {
                    _statusPriority: {
                        $cond: {
                            if: {
                                $in: ['$documents.verificationStatus', ['pending', 'manual-pending-verification']]
                            },
                            then: 0,
                            else: 1
                        }
                    }
                }
            },
            // Sort: pending first (0 before 1), then by uploadedAt descending within each group
            { $sort: { _statusPriority: 1, 'documents.uploadedAt': sortDir } },
            {
                $facet: {
                    data: [
                        { $skip: skip },
                        { $limit: parseInt(limit) },
                        {
                            $project: {
                                _id: 0,
                                documentId: '$documents._id',
                                documentType: '$documents.documentType',
                                fileName: '$documents.fileName',
                                verificationStatus: '$documents.verificationStatus',
                                uploadedAt: '$documents.uploadedAt',
                                verifiedAt: '$documents.verifiedAt',
                                rejectionReason: '$documents.rejectionReason',
                                s3Key: '$documents.s3Key',
                                extractedData: '$documents.extractedData',
                                userRole: '$userRole',
                                userId: '$userId',
                                userName: '$userInfo.name',
                                userEmail: '$userInfo.email'
                            }
                        }
                    ],
                    totalCount: [{ $count: 'count' }]
                }
            }
        ];

        const [result] = await Document.aggregate(pipeline);
        const docs = result.data || [];
        const total = result.totalCount[0]?.count || 0;

        // Generate presigned URLs
        const docsWithUrls = await Promise.all(
            docs.map(async (doc) => {
                let url = null;
                if (doc.s3Key) {
                    try { url = await generatePreSignedURL(doc.s3Key); } catch (_) {}
                }
                const { s3Key, ...rest } = doc;
                rest.extractedData = maskedExtractedData(doc.documentType, doc.extractedData);
                return { ...rest, url };
            })
        );

        return {
            documents: docsWithUrls,
            pagination: getPaginationMeta(total, parseInt(page), parseInt(limit))
        };
    },

    // GET /api/admin/documents/stats — verification stats for the dashboard donut + recent actions
    async getDocumentStats() {
        const statsPipeline = [
            { $unwind: '$documents' },
            { $match: { 'documents.isDeleted': false } },
            {
                $group: {
                    _id: '$documents.verificationStatus',
                    count: { $sum: 1 }
                }
            }
        ];

        const recentPipeline = [
            { $unwind: '$documents' },
            {
                $match: {
                    'documents.isDeleted': false,
                    'documents.verificationStatus': { $in: ['verified', 'rejected'] },
                    'documents.verifiedAt': { $exists: true }
                }
            },
            { $sort: { 'documents.verifiedAt': -1 } },
            { $limit: 5 },
            {
                $lookup: {
                    from: 'users',
                    localField: 'userId',
                    foreignField: '_id',
                    as: 'userInfo'
                }
            },
            { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
            {
                $project: {
                    _id: 0,
                    documentId: '$documents._id',
                    documentType: '$documents.documentType',
                    verificationStatus: '$documents.verificationStatus',
                    verifiedAt: '$documents.verifiedAt',
                    rejectionReason: '$documents.rejectionReason',
                    userName: '$userInfo.name',
                    userRole: '$userRole'
                }
            }
        ];

        const [statusCounts, recentActions] = await Promise.all([
            Document.aggregate(statsPipeline),
            Document.aggregate(recentPipeline)
        ]);

        const counts = { verified: 0, pending: 0, rejected: 0, 'manual-pending-verification': 0, 'auto-verified': 0 };
        statusCounts.forEach(s => { counts[s._id] = s.count; });

        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const pendingTotal = counts['pending'] + counts['manual-pending-verification'];

        return {
            total,
            approved: counts['verified'] + counts['auto-verified'],
            pending: pendingTotal,
            rejected: counts['rejected'],
            approvedPct: total ? Math.round(((counts['verified'] + counts['auto-verified']) / total) * 100) : 0,
            pendingPct: total ? Math.round((pendingTotal / total) * 100) : 0,
            rejectedPct: total ? Math.round((counts['rejected'] / total) * 100) : 0,
            recentActions
        };
    }
};
