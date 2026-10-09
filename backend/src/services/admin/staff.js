// Admin: medical staff lists, detail, verification and nearby search
// Methods of AdminService; mixed into the class in ../admin.service.js, so `this` is the service.
const Duty = require('../../models/Duty');
const MedicalStaff = require('../../models/MedicalStaff');
const Hospital = require('../../models/Hospital');
const Document = require('../../models/Document');
const { generatePreSignedURL } = require('../s3.service');
const { formatRoleForDisplay } = require('../../utils/helpers');
const { getPaginationParams, getPaginationMeta } = require('../../utils/pagination');
const geocodingService = require('../geocoding.service');
const EmailService = require('../email.service');
const CacheInvalidationService = require('../cacheInvalidation.service');
const cacheService = require('../cache.service');
const logger = require('../../utils/logger');
const notificationEmitter = require('../notificationEmitter');
const DashboardService = require('../dashboard.service');
const ratingAlgorithmService = require('../ratingAlgorithm.service');
const { maskedExtractedData } = require('../../utils/aadhaarMask');
const { ValidationError, NotFoundError, ConflictError } = require('../../middleware/error.middleware');
const { escapeRegex } = require('./helpers');

module.exports = {
    // Get medical staff list with filters
    async getMedicalStaffList(filters) {
        let { jobRole, isAvailable, page = 1, limit = 10 } = filters;

        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 10;
        let query = {};

        // Filter by jobRole (single or multiple, case-insensitive)
        if (jobRole) {
            const rolesArray = String(jobRole).split(',').map(r => new RegExp(`^${escapeRegex(r.trim())}$`, 'i'));
            query.jobRole = { $in: rolesArray };
        }

        // Filter by availability
        if (isAvailable !== undefined) {
            query.isAvailable = isAvailable === 'true';
        }

        const { skip } = getPaginationParams(pageNum, limitNum);
        const total = await MedicalStaff.countDocuments(query);

        const staff = await MedicalStaff.find(query)
            .populate('user', '_id email')
            .select('fullName jobRole isAvailable city area user')
            .sort({ fullName: 1 })
            .skip(skip)
            .limit(limitNum);
        // Aggregate completed duties
        const dutyCounts = await Duty.aggregate([
            {
                $match: {
                    assignedTo: { $in: staff.map(s => s._id) },
                    status: 'completed'
                }
            },
            {
                $group: {
                    _id: '$assignedTo',
                    count: { $sum: 1 }
                }
            }
        ]);

        // Convert to map
        const dutyMap = {};
        dutyCounts.forEach(d => {
            dutyMap[d._id.toString()] = d.count;
        });
        return {
            staff: staff.map(s => ({
                userId: s.user?._id || null,
                fullName: s.fullName,
                jobRole: s.jobRole,
                isAvailable: s.isAvailable,
                email: s.user?.email || null,
                completedDuties: dutyMap[s._id.toString()] || 0,
                location: `${s.area}, ${s.city}`
            })),
            pagination: getPaginationMeta(total, pageNum, limitNum)
        };
    },

    // Get nearby available staff using bounding box query 
    async getNearbyAvailableStaff(hospitalId, radiusKm, role = null) {
        try {
            // Input validation
            if (radiusKm < 1 || radiusKm > 100) {
                throw new ValidationError('Radius must be between 1km and 100km');
            }

            // Check cache first (1 minute for admin queries)
            const cacheKey = `admin:nearby:staff:${hospitalId}:${radiusKm}:${role || 'all'}`;
            const cached = await cacheService.get(cacheKey);
            if (cached) {
                return {
                    ...cached,
                    cached: true,
                    timestamp: new Date().toISOString()
                };
            }

            // Get hospital coordinates with minimal fields
            const hospital = await Hospital.findById(hospitalId)
                .select('_id hospitalLegalName coordinates currentAddress city state pincode')
                .lean();

            if (!hospital) {
                throw new NotFoundError('Hospital not found');
            }

            const hospitalLat = hospital.coordinates.coordinates.latitude;
            const hospitalLng = hospital.coordinates.coordinates.longitude;

            console.log(`Admin: Searching for staff within ${radiusKm}km radius using hybrid approach (bounding box + real-time location)`);

            // Bounding box query with profile coordinates (MongoDB indexed query)
            const latDelta = radiusKm / 111;
            const lngDelta = radiusKm / (111 * Math.cos(hospitalLat * Math.PI / 180));

            const query = {
                isAvailable: true,
                'coordinates.coordinates.latitude': {
                    $gte: hospitalLat - latDelta,
                    $lte: hospitalLat + latDelta
                },
                'coordinates.coordinates.longitude': {
                    $gte: hospitalLng - lngDelta,
                    $lte: hospitalLng + lngDelta
                }
            };

            if (role) {
                query.jobRole = role;
            }

            // Get staff within bounding box (reduces dataset significantly)
            const nearbyStaff = await MedicalStaff.find(query)
                .populate('user', 'name email')
                .select('fullName jobRole currentAddress city state pincode phoneNumber coordinates isAvailable averageRating totalRatings verificationStatus user isDemo')
                .sort({ 'coordinates.coordinates.latitude': 1, 'coordinates.coordinates.longitude': 1 })
                .lean();

            console.log(`Admin: Found ${nearbyStaff.length} staff within bounding box (profile coordinates)`);

            // Initialize Google Maps API call counters
            let googleMapsApiCalls = 0;
            let realTimeLocationCalls = 0;
            let fallbackLocationCalls = 0;


            // Get real-time location for all staff first (separate from distance calculation)
            const staffWithLocations = await Promise.allSettled(
                nearbyStaff.map(async (staffMember) => {
                    try {
                        // Check if user field exists before accessing
                        if (!staffMember.user || !staffMember.user._id) {
                            console.warn(`Admin: Staff ${staffMember._id} has no user field, using profile coordinates`);
                            return {
                                staff: staffMember,
                                staffLat: staffMember.coordinates.coordinates.latitude,
                                staffLng: staffMember.coordinates.coordinates.longitude,
                                locationSource: 'profile_fallback',
                                success: false
                            };
                        }

                        // Get real-time location from dashboard cache (falls back to profile location)
                        const locationData = await DashboardService.getStaffLocationForDuties(staffMember.user._id.toString());
                        
                        return {
                            staff: staffMember,
                            staffLat: locationData.location.latitude,
                            staffLng: locationData.location.longitude,
                            locationSource: locationData.source,
                            success: true
                        };
                    } catch (error) {
                        console.error(`Error getting real-time location for staff ${staffMember._id}:`, error.message);
                        // Fallback to profile coordinates if real-time location fails
                        return {
                            staff: staffMember,
                            staffLat: staffMember.coordinates.coordinates.latitude,
                            staffLng: staffMember.coordinates.coordinates.longitude,
                            locationSource: 'profile_fallback',
                            success: false
                        };
                    }
                })
            );

            // Filter successful results
            const validStaffWithLocations = staffWithLocations
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);

            console.log(`Admin: Found ${validStaffWithLocations.length} staff with location data`);

            // Prepare destinations for batch API call
            const destinations = validStaffWithLocations.map(s => ({
                id: s.staff._id.toString(),
                latitude: s.staffLat,
                longitude: s.staffLng
            }));

            // Single batch API call for all staff
            console.log(`Admin: Making 1 batch Google Maps API call for ${destinations.length} destinations`);
            const { resultMap: distanceResults, totalApiCalls: actualApiCalls } = await geocodingService.calculateBatchDistanceAndETA(
                hospitalLat,
                hospitalLng,
                destinations
            );
            googleMapsApiCalls = actualApiCalls;
            console.log(`[Admin Google Maps API] Batch call completed for ${destinations.length} destinations`);

            // Batched, not one call per staff member — see
            // ratingAlgorithm.service.js#getEffectiveRatingsForMany.
            const effectiveRatings = await ratingAlgorithmService.getEffectiveRatingsForMany(
                validStaffWithLocations.map(s => s.staff), 'hospital_to_staff'
            );

            // Combine staff with distance results
            const staffWithRealTimeLocation = validStaffWithLocations.map((s, index) => {
                const distanceResult = distanceResults.get(s.staff._id.toString());

                if (!distanceResult) {
                    console.warn(`Admin: No distance result for staff ${s.staff._id}`);
                    return null;
                }

                return {
                    id: s.staff._id,
                    name: s.staff.fullName,
                    email: s.staff.user?.email || null,
                    role: s.staff.jobRole,
                    formattedRole: formatRoleForDisplay(s.staff.jobRole),
                    phone: s.staff.phoneNumber,
                    rating: s.staff.totalRatings ? s.staff.averageRating : null,
                    effectiveRating: effectiveRatings[index].ratingShown,
                    isAvailable: s.staff.isAvailable,
                    isDemo: s.staff.isDemo === true,
                    verificationStatus: s.staff.verificationStatus,
                    distance: parseFloat(distanceResult.distance.toFixed(2)),
                    distanceText: distanceResult.distanceText,
                    estimatedTime: distanceResult.duration,
                    estimatedTimeText: distanceResult.durationText,
                    address: {
                        currentAddress: s.staff.currentAddress,
                        city: s.staff.city,
                        state: s.staff.state,
                        pincode: s.staff.pincode
                    },
                    location: {
                        latitude: s.staffLat,
                        longitude: s.staffLng,
                        source: s.locationSource
                    }
                };
            }).filter(s => s !== null);

            // Third pass: Filter by exact radius and sort
            const validStaff = staffWithRealTimeLocation
                .filter(s => s.distance <= radiusKm)
                .sort((a, b) => a.distance - b.distance);

            console.log(`Admin: Found ${validStaff.length} staff within exact distance using real-time location`);

            // Update counters based on location source
            realTimeLocationCalls = validStaffWithLocations.filter(s => s.success).length;
            fallbackLocationCalls = validStaffWithLocations.filter(s => !s.success).length;

            console.log(`[Admin Google Maps API] Total calls: ${googleMapsApiCalls} (Real-time locations: ${realTimeLocationCalls}, Fallback locations: ${fallbackLocationCalls})`);
            
            // Get duty status for all valid staff (batch optimized)
            const staffIds = validStaff.map(staff => staff.id);
            const { getBatchStaffDutyStatus } = require('../utils/dutyStatus.helper');
            const dutyStatusMap = await getBatchStaffDutyStatus(staffIds);

            // Add duty status to staff data
            const staffWithDutyStatus = validStaff.map(staff => {
                const dutyStatus = dutyStatusMap.get(staff.id.toString());
                
                return {
                    ...staff,
                    // Duty status fields
                    availabilityStatus: dutyStatus.status,
                    hasActiveDuty: dutyStatus.hasActiveDuty,
                    hasUpcomingDuty: dutyStatus.hasUpcomingDuty,
                    currentDuty: dutyStatus.currentDuty,
                    nextDuty: dutyStatus.nextDuty,
                    activeDutyCount: dutyStatus.activeDutyCount,
                    upcomingDutyCount: dutyStatus.upcomingDutyCount
                };
            });

            const result = {
                success: true,
                cached: false,
                data: {
                    hospital: {
                        id: hospital._id,
                        name: hospital.hospitalLegalName,
                        address: {
                            currentAddress: hospital.currentAddress ,
                            city: hospital.city,
                            state: hospital.state,
                            pincode: hospital.pincode
                        },
                        location: {
                            latitude: hospital.coordinates.coordinates.latitude,
                            longitude: hospital.coordinates.coordinates.longitude
                        }
                    },
                    search: {
                        radius: radiusKm,
                        roleFilter: role || 'all',
                        totalFound: staffWithDutyStatus.length,
                        locationSource: 'real_time' // Indicates using real-time location
                    },
                    staff: staffWithDutyStatus,
                    summary: {
                        totalStaff: staffWithDutyStatus.length,
                        fullyAvailable: staffWithDutyStatus.filter(s => s.availabilityStatus === 'fully_available').length,
                        hasUpcomingDuties: staffWithDutyStatus.filter(s => s.availabilityStatus === 'has_upcoming_duties').length,
                        hasActiveDuties: staffWithDutyStatus.filter(s => s.availabilityStatus === 'has_active_duties').length,
                        
                        verificationStats: {
                            verified: staffWithDutyStatus.filter(s => s.verificationStatus === 'verified').length,
                            pending: staffWithDutyStatus.filter(s => s.verificationStatus === 'pending').length,
                            rejected: staffWithDutyStatus.filter(s => s.verificationStatus === 'rejected').length
                        },
                        
                        // Location source statistics
                        usingRealTimeLocation: staffWithDutyStatus.filter(s => s.location.source === 'browser').length,
                        usingProfileLocation: staffWithDutyStatus.filter(s => s.location.source === 'profile' || s.location.source === 'profile_fallback').length
                    }
                },
                message: `Found ${staffWithDutyStatus.length} available staff within ${radiusKm}km radius${role ? ` for role: ${role}` : ''} using real-time location`,
                queryInfo: {
                    hospitalCoords: [hospitalLng, hospitalLat],
                    radiusMeters: radiusKm * 1000,
                    hasRoleFilter: !!role,
                    queryMethod: 'real_time_location_with_duty_status',
                    cached: false
                },
                timestamp: new Date().toISOString()
            };

            // Cache the result for 1 minute (admin data changes frequently)
            await cacheService.set(cacheKey, result, 60);
            return result;
        } catch (error) {
            console.error('Error in getNearbyAvailableStaff:', error);
            throw error;
        }
    },

    // GET /api/admin/medical-staff — paginated list with filters (search, role, availability)
    async getMedicalStaffListWithFilters({ search, role, availability, status, location, page = 1, limit = 10 }) {
        const { skip } = getPaginationParams(page, limit);

        // Build match stage
        const match = {};

        if (role) match.jobRole = role;
        if (availability !== undefined && availability !== null && availability !== '') {
            match.isAvailable = availability === 'true' || availability === true;
        }
        if (status) match.verificationStatus = status;

        // Location filter: regex across currentAddress and pincode
        if (location) {
            const locationRegex = { $regex: escapeRegex(location), $options: 'i' };
            match.$or = [
                { currentAddress: locationRegex },
                { pincode: locationRegex }
            ];
        }

        const pipeline = [
            { $match: match },
            {
                $lookup: {
                    from: 'users',
                    localField: 'user',
                    foreignField: '_id',
                    as: 'userInfo'
                }
            },
            { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
            
            // Add search filter for name and email only
            ...(search ? [{
                $match: {
                    $or: [
                        { fullName: { $regex: escapeRegex(search.trim()), $options: 'i' } },
                        { 'userInfo.email': { $regex: escapeRegex(search.trim()), $options: 'i' } },
                        { 'userInfo.name': { $regex: escapeRegex(search.trim()), $options: 'i' } }
                    ]
                }
            }] : []),
            
            // Lookup completed duties count
            {
                $lookup: {
                    from: 'duties',
                    let: { staffId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ['$assignedTo', '$$staffId'] },
                                        { $eq: ['$status', 'completed'] }
                                    ]
                                }
                            }
                        },
                        { $count: 'count' }
                    ],
                    as: 'completedDuties'
                }
            },
            
            { $sort: { fullName: 1 } },
            
            {
                $facet: {
                    data: [
                        { $skip: skip },
                        { $limit: parseInt(limit) },
                        {
                            $project: {
                                _id: 1,
                                staffId: '$_id',
                                fullName: 1,
                                jobRole: 1,
                                currentAddress: '$currentAddress',
                                city: '$city', 
                                state: '$state',
                                pincode: '$pincode',
                                email: '$userInfo.email',
                                phoneNumber: 1,
                                profilePicture: 1,
                                completedDuties: { $ifNull: [{ $arrayElemAt: ['$completedDuties.count', 0] }, 0] },
                                isAvailable: 1,
                                isDemo: { $eq: ['$isDemo', true] },
                                verificationStatus: { $ifNull: ['$verificationStatus', 'pending'] },
                                userId: '$user'
                            }
                        }
                    ],
                    totalCount: [{ $count: 'count' }]
                }
            }
        ];

        const [result] = await MedicalStaff.aggregate(pipeline);

        // Generate pre-signed URLs for profile pictures
        const staffWithUrls = await Promise.all((result.data || []).map(async (staff) => {
            let profilePictureUrl = null;
            if (staff.profilePicture?.s3Key) {
                try {
                    profilePictureUrl = await generatePreSignedURL(staff.profilePicture.s3Key);
                } catch (error) {
                    console.error('Error generating profile picture URL:', error);
                }
            }
            return {
                ...staff,
                profilePicture: profilePictureUrl
            };
        }));

        return {
            staff: staffWithUrls,
            pagination: getPaginationMeta(result.totalCount[0]?.count || 0, parseInt(page), parseInt(limit))
        };
    },

    // GET /api/admin/medical-staff-list — verified staff list with city and jobRole filters
    async getVerifiedMedicalStaffList({ city, jobRole, page = 1, limit = 10 }) {
        const { skip } = getPaginationParams(page, limit);
    
        // Build match stage - only verified staff
        const match = { verificationStatus: 'verified' };
            
        if (city) match.city = { $regex: escapeRegex(city.trim()), $options: 'i' };
        if (jobRole) match.jobRole = jobRole;
    
        const pipeline = [
            { $match: match },
            {
                $lookup: {
                    from: 'users',
                    localField: 'user',
                    foreignField: '_id',
                    as: 'userInfo'
                }
            },
            { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
            { $sort: { fullName: 1 } },
            {
                $facet: {
                    data: [
                        { $skip: skip },
                        { $limit: parseInt(limit) },
                        {
                            $project: {
                                _id: 1,
                                staffId: '$_id',
                                fullName: 1,
                                jobRole: 1,
                                isAvailable: 1,
                                userId: '$user',
                                currentAddress: 1,
                                city: 1,
                                state: 1,
                                pincode: 1,
                                email: '$userInfo.email',
                                verificationStatus: 1,
                                profilePicture: 1
                            }
                        }
                    ],
                    totalCount: [{ $count: 'count' }]
                }
            }
        ];
    
        const [result] = await MedicalStaff.aggregate(pipeline);
    
        // Generate pre-signed URLs for profile pictures
        const staffWithUrls = await Promise.all((result.data || []).map(async (staff) => {
            let profilePictureUrl = null;
            if (staff.profilePicture?.s3Key) {
                try {
                    profilePictureUrl = await generatePreSignedURL(staff.profilePicture.s3Key);
                } catch (error) {
                    console.error('Error generating profile picture URL:', error);
                }
            }
            return {
                fullName: staff.fullName,
                jobRole: staff.jobRole,
                isAvailable: staff.isAvailable,
                staffId: staff.staffId,
                userId: staff.userId,
                currentAddress: staff.currentAddress,
                city: staff.city,
                state: staff.state,
                pincode: staff.pincode,
                email: staff.email,
                verificationStatus: staff.verificationStatus,
                profilePicture: profilePictureUrl
            };
        }));
    
        return {
            staff: staffWithUrls,
            pagination: getPaginationMeta(result.totalCount[0]?.count || 0, parseInt(page), parseInt(limit))
        };
    },

    // GET /api/admin/medical-staff/:staffId — detailed view for review modal
    async getMedicalStaffDetail(staffId) {
        const staff = await MedicalStaff.findById(staffId)
            .populate('user', 'name email createdAt')
            .lean();

        if (!staff) throw new NotFoundError('Medical staff not found');

        // Documents are stored against the User's _id, not the MedicalStaff profile's _id
        const docRecord = await Document.findOne({ userId: staff.user._id }).lean();
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
                    extractedData: maskedExtractedData(doc.documentType, doc.extractedData),
                    url
                });
            }
        }

        // Get completed duties count
        const completedDuties = await Duty.countDocuments({
            assignedTo: staff._id,
            status: 'completed'
        });

        const { ratingShown, breakdown } = await ratingAlgorithmService.getEffectiveRating(staff, 'hospital_to_staff');

        return {
            id: staff._id,
            userId: staff.user?._id,
            fullName: staff.fullName,
            jobRole: staff.jobRole,
            currentAddress: staff.currentAddress,
            city: staff.city,
            state: staff.state,
            pincode: staff.pincode,
            location: staff.currentAddress ? 
                `${staff.currentAddress}, ${staff.city}, ${staff.state} - ${staff.pincode}` : 
                `${staff.city}, ${staff.state} - ${staff.pincode}`,
            phoneNumber: staff.phoneNumber,
            email: staff.user?.email,
            profileSummary: staff.profileSummary,
            education: staff.education,
            skills: staff.skills,
            isAvailable: staff.isAvailable,
            isProfileComplete: staff.isProfileComplete,
            verificationStatus: staff.verificationStatus || 'pending',
            rejectionReason: staff.rejectionReason,
            isSuspended: staff.isSuspended || false,
            suspensionReason: staff.suspensionReason || null,
            suspendedAt: staff.suspendedAt || null,
            experience: staff.experience,
            averageRating: staff.averageRating,
            totalRatings: staff.totalRatings,
            effectiveRating: ratingShown,
            ratingBreakdown: breakdown,
            completedDuties,
            coordinates: {
                latitude: staff.coordinates?.coordinates?.latitude,
                longitude: staff.coordinates?.coordinates?.longitude
            },
            createdAt: staff.createdAt,
            documents
        };
    },

    // PATCH /api/admin/medical-staff/:staffId/verify — verify medical staff account
    async verifyMedicalStaff(staffId) {
        const staff = await MedicalStaff.findById(staffId).populate('user', 'name email');
        if (!staff) throw new NotFoundError('Medical staff not found');

        // Allow: pending → verified, rejected → verified
        if (staff.verificationStatus === 'verified') {
            throw new ConflictError('Medical staff is already verified');
        }

        const previousStatus = staff.verificationStatus;
        staff.verificationStatus = 'verified';
        staff.verifiedAt = new Date();
        staff.rejectionReason = null; // clear reason if coming from rejected
        staff.isAvailable = staff.isProfileComplete === true;
        await staff.save();

        // Invalidate availability cache after enabling
        await cacheService.del(`staff_availability:${staff.user._id}`);

        // IMMEDIATE: Invalidate cache with retry mechanism
        const cacheInvalidated = await CacheInvalidationService.invalidateStaffVerificationCache(staff.user._id);

        if (!cacheInvalidated) {
            logger.error(`Failed to invalidate cache for staff ${staffId} after verification`);
        }

        // IMMEDIATE: Refresh cache to ensure consistency
        const cacheRefreshed = await CacheInvalidationService.refreshStaffVerificationCache(staff.user._id);

        if (!cacheRefreshed) {
            logger.error(`Failed to refresh cache for staff ${staffId} after verification`);
        }

        // Clear profile caches so /profile/me reflects the new verification status
        const verifiedUserId = staff.user._id.toString();
        await Promise.allSettled([
            cacheService.invalidateUserProfiles(verifiedUserId),
            cacheService.invalidateProfileStatus(verifiedUserId)
        ]);

        logger.info(`Profile cache invalidated for staff ${staffId} after verification`);

        logger.info(`Medical staff ${staffId} verified: ${previousStatus} → verified`);

        // Send email to staff
        EmailService.sendMedicalStaffVerifiedEmail(staff.user.email, staff.fullName)
            .catch(err => logger.error('Verify email error:', err.message));

        // Send notifications to staff and admins
        notificationEmitter.emitStaffVerified(staff, staff.user._id.toString())
            .catch(err => logger.error('Verification notification error:', err.message));

        return { 
            id: staff._id, 
            verificationStatus: staff.verificationStatus,
            previousStatus: previousStatus,
            isAvailable: staff.isAvailable, 
            message: staff.isAvailable ? 'Staff verified and availability enabled' : 'Staff verified',
            cacheInvalidated: cacheInvalidated,
            cacheRefreshed: !!cacheRefreshed
        };
    },

    // PATCH /api/admin/medical-staff/:staffId/reject — reject medical staff account
    async rejectMedicalStaff(staffId, reason) {
        if (!reason) throw new ValidationError('Rejection reason is required');

        const staff = await MedicalStaff.findById(staffId).populate('user', 'name email');
        if (!staff) throw new NotFoundError('Medical staff not found');

        // Allow: pending → rejected only
        // verified → rejected is NOT allowed
        if (staff.verificationStatus === 'verified') {
            throw new ConflictError('Verified medical staff cannot be rejected. Verification is final.');
        }
        if (staff.verificationStatus === 'rejected') {
            throw new ConflictError('Medical staff is already rejected');
        }

        const previousStatus = staff.verificationStatus;
        staff.verificationStatus = 'rejected';
        staff.rejectionReason = reason;
        await staff.save();

        // IMMEDIATE: Invalidate cache with retry mechanism
        const cacheInvalidated = await CacheInvalidationService.invalidateStaffVerificationCache(staff.user._id);

        if (!cacheInvalidated) {
            logger.error(`Failed to invalidate cache for staff ${staffId} after rejection`);
        }

        // IMMEDIATE: Refresh cache to ensure consistency
        const cacheRefreshed = await CacheInvalidationService.refreshStaffVerificationCache(staff.user._id);

        if (!cacheRefreshed) {
            logger.error(`Failed to refresh cache for staff ${staffId} after rejection`);
        }

        // Clear profile caches so /profile/me reflects the new verification status
        const rejectedUserId = staff.user._id.toString();
        await Promise.allSettled([
            cacheService.invalidateUserProfiles(rejectedUserId),
            cacheService.invalidateProfileStatus(rejectedUserId)
        ]);

        logger.info(`Profile cache invalidated for staff ${staffId} after rejection`);
        
        logger.info(`Medical staff ${staffId} rejected: ${previousStatus} → rejected (Reason: ${reason})`);
        // Send email to staff
        EmailService.sendMedicalStaffRejectedEmail(staff.user.email, staff.fullName, reason)
            .catch(err => logger.error('Reject email error:', err.message));

        // Send notifications to staff and admins
        notificationEmitter.emitStaffRejected(staff, staff.user._id.toString(), reason)
            .catch(err => logger.error('Rejection notification error:', err.message));

        return { 
            id: staff._id, 
            verificationStatus: staff.verificationStatus, 
            rejectionReason: staff.rejectionReason,
            previousStatus: previousStatus,
            cacheInvalidated: cacheInvalidated,
            cacheRefreshed: !!cacheRefreshed
        };
    }
};
