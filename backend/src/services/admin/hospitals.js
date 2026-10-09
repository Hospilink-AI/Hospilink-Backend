// Admin: hospital lists, detail and verification
// Methods of AdminService; mixed into the class in ../admin.service.js, so `this` is the service.
const mongoose = require('mongoose');
const Hospital = require('../../models/Hospital');
const Document = require('../../models/Document');
const { generatePreSignedURL } = require('../s3.service');
const { getPaginationParams, getPaginationMeta } = require('../../utils/pagination');
const EmailService = require('../email.service');
const CacheInvalidationService = require('../cacheInvalidation.service');
const cacheService = require('../cache.service');
const logger = require('../../utils/logger');
const notificationEmitter = require('../notificationEmitter');
const ratingAlgorithmService = require('../ratingAlgorithm.service');
const { ValidationError, NotFoundError, ConflictError } = require('../../middleware/error.middleware');
const { escapeRegex } = require('./helpers');

module.exports = {
    // GET /api/admin/hospitals-list — simple list with id, name, location (for dropdowns)
    async getHospitalSimpleList(nameFilter = null) {
        const match = {};
        
        if (nameFilter) {
            match.hospitalLegalName = { $regex: escapeRegex(nameFilter.trim()), $options: 'i' };
        }

        const hospitals = await Hospital.find(match)
            .select('_id hospitalLegalName currentAddress city state pincode verificationStatus')
            .sort({ hospitalLegalName: 1 })
            .lean();

        return hospitals.map(h => ({
            id: h._id,
            name: h.hospitalLegalName,
            location: `${h.currentAddress}, ${h.city}, ${h.state}, ${h.pincode}`,
            verificationStatus: h.verificationStatus
        }));
    },

    // GET /api/admin/hospitals — paginated, filtered hospital list
    async getHospitalList({ search, status, city, location, page = 1, limit = 10 }) {
        const { skip } = getPaginationParams(page, limit);

        // Build match stage
        const match = {};
        if (status) match.verificationStatus = status;
        if (city) match.city = { $regex: escapeRegex(city.trim()), $options: 'i' };

        // Location filter: regex across currentAddress and pincode
        if (location) {
            const locationRegex = { $regex: escapeRegex(location.trim()), $options: 'i' };
            match.$or = [
                { currentAddress: locationRegex },
                { pincode: locationRegex }
            ];
        }

        if (search) {
            const re = { $regex: escapeRegex(search.trim()), $options: 'i' };
            match.$or = [{ hospitalLegalName: re }];
            // also allow searching by mongo _id string
            if (mongoose.Types.ObjectId.isValid(search.trim())) {
                match.$or.push({ _id: new mongoose.Types.ObjectId(search.trim()) });
            }
        }

        const pipeline = [
            { $match: match },
            { $sort: { hospitalLegalName: 1 } },
            {
                $lookup: {
                    from: 'duties',
                    let: { hid: '$_id' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$hospital', '$$hid'] } } },
                        { $group: {
                            _id: null,
                            total: { $sum: 1 },
                            occupied: { $sum: { $cond: [{ $in: ['$status', ['assigned', 'enroute', 'in-progress']] }, 1, 0] } }
                        }}
                    ],
                    as: 'dutyStats'
                }
            },
            {
                $lookup: {
                    from: 'documents',
                    localField: 'user',
                    foreignField: 'userId',
                    as: 'docRecord'
                }
            },
            {
                $facet: {
                    data: [
                        { $skip: skip },
                        { $limit: parseInt(limit) },
                        {
                            $project: {
                                _id: 1,
                                userId: '$user',
                                hospitalLegalName: 1,
                                currentAddress: 1,
                                city: 1,
                                state: 1,
                                pincode: 1,
                                staffCount: 1,
                                isDemo: { $eq: ['$isDemo', true] },
                                verificationStatus: '$verificationStatus',
                                rejectionReason: '$rejectionReason',
                                createdAt: 1,
                                profilePicture: 1,
                                totalDuties: { $ifNull: [{ $arrayElemAt: ['$dutyStats.total', 0] }, 0] },
                                occupiedDuties: { $ifNull: [{ $arrayElemAt: ['$dutyStats.occupied', 0] }, 0] },
                                totalDocuments: { $size: { $ifNull: [{ $arrayElemAt: ['$docRecord.documents', 0] }, []] } },
                                verifiedDocuments: {
                                    $size: {
                                        $filter: {
                                            input: { $ifNull: [{ $arrayElemAt: ['$docRecord.documents', 0] }, []] },
                                            as: 'd',
                                            cond: { $and: [
                                                { $eq: ['$$d.verificationStatus', 'verified'] },
                                                { $ne: ['$$d.isDeleted', true] }
                                            ]}
                                        }
                                    }
                                }
                            }
                        }
                    ],
                    totalCount: [{ $count: 'count' }]
                }
            }
        ];

        const [result] = await Hospital.aggregate(pipeline);

        // Generate pre-signed URLs for profile pictures
        const hospitalsWithUrls = await Promise.all((result.data || []).map(async (hospital) => {
            let profilePictureUrl = null;
            if (hospital.profilePicture?.s3Key) {
                try {
                    profilePictureUrl = await generatePreSignedURL(hospital.profilePicture.s3Key);
                } catch (error) {
                    console.error('Error generating profile picture URL:', error);
                }
            }
            return {
                ...hospital,
                profilePicture: profilePictureUrl
            };
        }));

        return {
            hospitals: hospitalsWithUrls,
            pagination: getPaginationMeta(result.totalCount[0]?.count || 0, parseInt(page), parseInt(limit))
        };
    },

    // GET /api/admin/hospitals/:id — preview modal
    async getHospitalDetail(hospitalId) {
        const hospital = await Hospital.findById(hospitalId)
            .populate('user', 'name email createdAt')
            .lean();

        if (!hospital) throw new NotFoundError('Hospital not found');

        const { ratingShown, breakdown } = await ratingAlgorithmService.getEffectiveRating(hospital, 'staff_to_hospital');

        // Documents are stored against the User's _id, not the Hospital profile's _id
        const docRecord = await Document.findOne({ userId: hospital.user._id }).lean();
        const documents = [];

        if (docRecord?.documents) {
            for (const doc of docRecord.documents.filter(d => !d.isDeleted)) {
                let url = null;
                if (doc.s3Key) {
                    try { url = await generatePreSignedURL(doc.s3Key); } catch (_) {}
                }
                documents.push({
                    id: doc._id,
                    documentType: doc.documentType,
                    fileName: doc.fileName,
                    verificationStatus: doc.verificationStatus,
                    uploadedAt: doc.uploadedAt,
                    verifiedAt: doc.verifiedAt,
                    rejectionReason: doc.rejectionReason,
                    url
                });
            }
        }

        return {
            id: hospital._id,
            hospitalLegalName: hospital.hospitalLegalName,
            currentAddress: hospital.currentAddress,
            city: hospital.city,
            state: hospital.state,
            pincode: hospital.pincode,
            staffCount: hospital.staffCount,
            servicesAvailable: hospital.servicesAvailable,
            averageRating: hospital.averageRating,
            totalRatings: hospital.totalRatings,
            effectiveRating: ratingShown,
            ratingBreakdown: breakdown,
            verificationStatus: hospital.verificationStatus,
            rejectionReason: hospital.rejectionReason,
            isSuspended: hospital.isSuspended || false,
            suspensionReason: hospital.suspensionReason || null,
            suspendedAt: hospital.suspendedAt || null,
            isProfileComplete: hospital.isProfileComplete,
            coordinates: {
                latitude: hospital.coordinates?.coordinates?.latitude,
                longitude: hospital.coordinates?.coordinates?.longitude
            },
            user: {
                id: hospital.user?._id,
                name: hospital.user?.name,
                email: hospital.user?.email
            },
            createdAt: hospital.createdAt,
            documents
        };
    },

    // PATCH /api/admin/hospitals/:id/verify
    async verifyHospital(hospitalId) {
        const hospital = await Hospital.findById(hospitalId).populate('user', 'name email');
        if (!hospital) throw new NotFoundError('Hospital not found');

        // Allow: pending → verified, rejected → verified
        if (hospital.verificationStatus === 'verified') {
            throw new ConflictError('Hospital is already verified');
        }

        const previousStatus = hospital.verificationStatus;
        hospital.verificationStatus = 'verified';
        hospital.verifiedAt = new Date();
        hospital.rejectionReason = null; // clear reason if coming from rejected
        await hospital.save();

        // Invalidate cache with retry mechanism
        const cacheInvalidated = await CacheInvalidationService.invalidateHospitalVerificationCache(hospital.user._id);
        
        if (!cacheInvalidated) {
            logger.error(`Failed to invalidate cache for hospital ${hospitalId} after verification`);
        }

        // Refresh cache to ensure consistency
        const cacheRefreshed = await CacheInvalidationService.refreshHospitalVerificationCache(hospital.user._id);
        
        if (!cacheRefreshed) {
            logger.error(`Failed to refresh cache for hospital ${hospitalId} after verification`);
        }

        // Also clear profile and profile-status caches so /profile/me reflects the new status
        const userId = hospital.user._id.toString();
        await Promise.allSettled([
            cacheService.invalidateUserProfiles(userId),
            cacheService.invalidateProfileStatus(userId)
        ]);

        logger.info(`Hospital ${hospitalId} verified: ${previousStatus} → verified`);

        // Send email to hospital
        EmailService.sendHospitalVerifiedEmail(hospital.user.email, hospital.hospitalLegalName)
            .catch(err => logger.error('Verify email error:', err.message));

        // Send notifications to hospital and admins
        notificationEmitter.emitHospitalVerified(hospital, hospital.user._id.toString())
            .catch(err => logger.error('Verification notification error:', err.message));

        return { 
            id: hospital._id, 
            verificationStatus: hospital.verificationStatus,
            previousStatus: previousStatus,
            cacheInvalidated: cacheInvalidated,
            cacheRefreshed: !!cacheRefreshed
        };
    },

    // PATCH /api/admin/hospitals/:id/reject
    async rejectHospital(hospitalId, reason) {
        if (!reason) throw new ValidationError('Rejection reason is required');

        const hospital = await Hospital.findById(hospitalId).populate('user', 'name email');
        if (!hospital) throw new NotFoundError('Hospital not found');

        // Allow: pending → rejected only
        // verified → rejected is NOT allowed
        if (hospital.verificationStatus === 'verified') {
            throw new ConflictError('Verified hospital cannot be rejected. Verification is final.');
        }
        if (hospital.verificationStatus === 'rejected') {
            throw new ConflictError('Hospital is already rejected');
        }

        const previousStatus = hospital.verificationStatus;
        hospital.verificationStatus = 'rejected';
        hospital.rejectionReason = reason;
        await hospital.save();

        // IMMEDIATE: Invalidate cache with retry mechanism
        const cacheInvalidated = await CacheInvalidationService.invalidateHospitalVerificationCache(hospital.user._id);
        
        if (!cacheInvalidated) {
            logger.error(`Failed to invalidate cache for hospital ${hospitalId} after rejection`);
        }

        // IMMEDIATE: Refresh cache to ensure consistency
        const cacheRefreshed = await CacheInvalidationService.refreshHospitalVerificationCache(hospital.user._id);
        
        if (!cacheRefreshed) {
            logger.error(`Failed to refresh cache for hospital ${hospitalId} after rejection`);
        }

        // Clear profile caches so /profile/me reflects the new status
        const rejectedUserId = hospital.user._id.toString();
        await Promise.allSettled([
            cacheService.invalidateUserProfiles(rejectedUserId),
            cacheService.invalidateProfileStatus(rejectedUserId)
        ]);

        logger.info(`Hospital ${hospitalId} rejected: ${previousStatus} → rejected (Reason: ${reason})`);

        // Send email to hospital
        EmailService.sendHospitalRejectedEmail(hospital.user.email, hospital.hospitalLegalName, reason)
            .catch(err => logger.error('Reject email error:', err.message));

        // Send notifications to hospital and admins
        notificationEmitter.emitHospitalRejected(hospital, hospital.user._id.toString(), reason)
            .catch(err => logger.error('Rejection notification error:', err.message));

        return { 
            id: hospital._id, 
            verificationStatus: hospital.verificationStatus, 
            rejectionReason: hospital.rejectionReason,
            previousStatus: previousStatus,
            cacheInvalidated: cacheInvalidated,
            cacheRefreshed: !!cacheRefreshed
        };
    }
};
