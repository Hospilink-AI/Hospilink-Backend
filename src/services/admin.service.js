const mongoose = require('mongoose');
const Duty = require('../models/Duty');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const Review = require('../models/Review');
const Document = require('../models/Document');
const User = require('../models/User');
const { generatePreSignedURL } = require('./s3.service');
const { calculateDutyDuration, formatDuration } = require('../utils/helpers');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const geocodingService = require('./geocoding.service');
const locationTrackingService = require('./locationTracking.service');
const redisClient = require('../config/redis');
const { getBatchStaffLocations, formatActiveDuty } = require('../utils/activeDuty.helper');


class AdminService {
    // Parse DD-MM-YYYY format to Date object
    parseDDMMYYYY(dateString) {
        if (!dateString) return null;

        const parts = dateString.split('-');
        if (parts.length !== 3) return null;

        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1; // JavaScript months are 0-indexed
        const year = parseInt(parts[2], 10);

        if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
        if (day < 1 || day > 31) return null;
        if (month < 0 || month > 11) return null;
        if (year < 1900 || year > 2100) return null;

        const date = new Date(year, month, day);
        // Validate that the date is valid 
        if (date.getDate() !== day || date.getMonth() !== month || date.getFullYear() !== year) {
            return null;
        }

        return date;
    }


    // Build date filter based on parameters
    buildDateFilter(startDate, endDate, date) {
        let dateFilter = {};

        if (date) {
            // Single date filter
            const targetDate = this.parseDDMMYYYY(date);
            if (!targetDate) {
                throw new Error('Invalid date format. Use DD-MM-YYYY format');
            }

            dateFilter = {
                $gte: new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()),
                $lt: new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate() + 1)
            };
        } else if (startDate && endDate) {
            // Date range filter
            const start = this.parseDDMMYYYY(startDate);
            const end = this.parseDDMMYYYY(endDate);

            if (!start || !end) {
                throw new Error('Invalid date format. Use DD-MM-YYYY format (e.g., 15-03-2024)');
            }

            if (start > end) {
                throw new Error('Start date must be before or equal to end date');
            }

            dateFilter = {
                $gte: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
                $lt: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) // Include end date
            };
        } else {
            // Default to today
            const today = new Date();
            dateFilter = {
                $gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
                $lt: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
            };
        }

        return dateFilter;
    }



    // Helper function to format duration using existing calculateDutyDuration
    // formatDuration(startTime, endTime, date, isOvernightDuty, endDate) {
    //     const durationHours = calculateDutyDuration(date, startTime, endTime, isOvernightDuty, endDate);
    //     const totalMinutes = Math.floor(durationHours * 60);

    //     if (totalMinutes < 60) {
    //         return `${totalMinutes} min`;
    //     } else {
    //         const hours = Math.floor(totalMinutes / 60);
    //         const minutes = totalMinutes % 60;
    //         return `${hours}h ${minutes}m`;
    //     }
    // }



    // GET /api/admin/dashboard-stats - Get dashboard overview statistics
    async getDashboardStats() {
        try {
            const pipeline = [
                {
                    $facet: {
                        // Total Hospitals
                        totalHospitals: [
                            { $count: 'count' }
                        ],
                        
                        // Previous period hospitals (for percentage change)
                        previousHospitals: [
                            {
                                $match: {
                                    createdAt: {
                                        $gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
                                        $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)   // 30 days ago
                                    }
                                }
                            },
                            { $count: 'count' }
                        ],
                        
                        // Recent hospitals (last 30 days)
                        recentHospitals: [
                            {
                                $match: {
                                    createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                                }
                            },
                            { $count: 'count' }
                        ]
                    }
                }
            ];

            const [hospitalStats] = await Hospital.aggregate(pipeline);

            // Medical Staff stats
            const staffPipeline = [
                {
                    $facet: {
                        totalStaff: [{ $count: 'count' }],
                        previousStaff: [
                            {
                                $match: {
                                    createdAt: {
                                        $gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
                                        $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                                    }
                                }
                            },
                            { $count: 'count' }
                        ],
                        recentStaff: [
                            {
                                $match: {
                                    createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                                }
                            },
                            { $count: 'count' }
                        ]
                    }
                }
            ];

            const [staffStats] = await MedicalStaff.aggregate(staffPipeline);

            // Pending Verifications (hospitals + medical staff with pending status)
            const pendingHospitals = await Hospital.countDocuments({ verificationStatus: 'pending' });
            const pendingStaff = await MedicalStaff.countDocuments({ verificationStatus: 'pending' });
            const totalPendingVerifications = pendingHospitals + pendingStaff;

            // Active Duties (assigned, enroute, in-progress)
            const activeDuties = await Duty.countDocuments({
                status: { $in: ['assigned', 'enroute', 'in-progress'] }
            });

            // Calculate percentage changes
            const totalHospitals = hospitalStats.totalHospitals[0]?.count || 0;
            const previousHospitals = hospitalStats.previousHospitals[0]?.count || 0;
            const recentHospitals = hospitalStats.recentHospitals[0]?.count || 0;
            
            const totalStaff = staffStats.totalStaff[0]?.count || 0;
            const previousStaff = staffStats.previousStaff[0]?.count || 0;
            const recentStaff = staffStats.recentStaff[0]?.count || 0;

            // Calculate percentage change (comparing recent 30 days vs previous 30 days)
            const hospitalChange = previousHospitals > 0 
                ? Math.round(((recentHospitals - previousHospitals) / previousHospitals) * 100)
                : recentHospitals > 0 ? 100 : 0;

            const staffChange = previousStaff > 0
                ? Math.round(((recentStaff - previousStaff) / previousStaff) * 100)
                : recentStaff > 0 ? 100 : 0;

            return {
                totalHospitals: {
                    count: totalHospitals,
                    change: hospitalChange,
                    changeLabel: hospitalChange >= 0 ? `+${hospitalChange}%` : `${hospitalChange}%`,
                    trend: hospitalChange >= 0 ? 'up' : 'down'
                },
                medicalStaff: {
                    count: totalStaff,
                    change: staffChange,
                    changeLabel: staffChange >= 0 ? `+${staffChange}%` : `${staffChange}%`,
                    trend: staffChange >= 0 ? 'up' : 'down'
                },
                pendingVerifications: {
                    count: totalPendingVerifications,
                    hospitals: pendingHospitals,
                    staff: pendingStaff,
                    status: totalPendingVerifications > 20 ? 'urgent' : 'normal'
                },
                activeDuties: {
                    count: activeDuties,
                    status: 'live'
                }
            };
        } catch (error) {
            throw error;
        }
    }




    // Get staff statistics grouped by job role
    async getStaffStatistics() {
        try {
            // Aggregate pipeline to group staff by job role and calculate statistics
            const roleStats = await MedicalStaff.aggregate([
                {
                    $group: {
                        _id: '$jobRole',
                        totalStaff: { $sum: 1 },
                        availableStaff: {
                            $sum: { $cond: [{ $eq: ['$isAvailable', true] }, 1, 0] }
                        }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        jobRole: '$_id',
                        totalStaff: 1,
                        availableStaff: 1,
                        availabilityPercentage: {
                            $multiply: [
                                {
                                    $cond: [
                                        { $eq: ['$totalStaff', 0] },
                                        0,
                                        { $divide: ['$availableStaff', '$totalStaff'] }
                                    ]
                                },
                                100
                            ]
                        }
                    }
                },
                {
                    $sort: { jobRole: 1 }
                }
            ]);

            // Calculate overall statistics
            const overallStats = await MedicalStaff.aggregate([
                {
                    $group: {
                        _id: null,
                        totalStaff: { $sum: 1 },
                        availableStaff: {
                            $sum: { $cond: [{ $eq: ['$isAvailable', true] }, 1, 0] }
                        }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        totalStaff: 1,
                        availableStaff: 1,
                        availabilityPercentage: {
                            $multiply: [
                                {
                                    $cond: [
                                        { $eq: ['$totalStaff', 0] },
                                        0,
                                        { $divide: ['$availableStaff', '$totalStaff'] }
                                    ]
                                },
                                100
                            ]
                        }
                    }
                }
            ]);

            return {
                overall: overallStats[0] || {
                    totalStaff: 0,
                    availableStaff: 0,
                    availabilityPercentage: 0
                },
                byRole: roleStats
            };
        } catch (error) {
            throw error;
        }
    }



    // Get medical staff list with filters
    async getMedicalStaffList(filters) {
        let { jobRole, isAvailable, page = 1, limit = 10 } = filters;

        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 10;
        let query = {};

        // Filter by jobRole (single or multiple, case-insensitive)
        if (jobRole) {
            const rolesArray = jobRole.split(',').map(r => new RegExp(`^${r.trim()}$`, 'i'));
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
        // Get all staff userIds
        const userIds = staff
            .map(s => s.user?._id)
            .filter(id => id);

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
    }


    // Get nearby available staff using bounding box query (same as working profile service)
    async getNearbyAvailableStaff(hospitalId, distanceKm, role = null) {
        try {
            // Get hospital coordinates first
            const hospital = await Hospital.findById(hospitalId)
                .select('coordinates coordinatesArray hospitalLegalName')
                .lean();

            if (!hospital) {
                throw new Error('Hospital not found');
            }

            const hospitalLat = hospital.coordinates.coordinates.latitude;
            const hospitalLng = hospital.coordinates.coordinates.longitude;

            console.log('Searching for staff within', distanceKm, 'km radius using Google Maps API only');

            // Use bounding box query 
            const latDelta = distanceKm / 111; // Approximate km to degrees
            const lngDelta = distanceKm / (111 * Math.cos(hospitalLat * Math.PI / 180));

            // Build query with bounding box
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

            // Add role filter if specified
            if (role) {
                query.jobRole = role;
            }

            const nearbyStaff = await MedicalStaff.find(query)
                .populate('user', 'name email')
                .select('fullName jobRole city area phoneNumber coordinates isAvailable averageRating user');

            console.log('Found', nearbyStaff.length, 'candidates via bounding box');

            // Filter by Google Maps API distance only
            const staffWithDistance = await Promise.all(
                nearbyStaff.map(async (staffMember) => {
                    try {
                        // Use Google Maps API only for distance calculation
                        let distanceResult;
                        try {
                            distanceResult = await geocodingService.calculateDistanceAndETA(
                                hospitalLat,
                                hospitalLng,
                                staffMember.coordinates.coordinates.latitude,
                                staffMember.coordinates.coordinates.longitude
                            );
                            
                            // Only include staff within Google Maps distance
                            if (distanceResult.distance > distanceKm) {
                                return null; // Filter out based on Google Maps distance
                            }
                            
                        } catch (apiError) {
                            console.error(`Google Maps API failed for staff ${staffMember._id}:`, apiError.message);
                            return null; // Skip staff if Google Maps API fails
                        }

                        return {
                            _id: staffMember._id,
                            staffName: staffMember.fullName,
                            location: `${staffMember.area}, ${staffMember.city}`,
                            role: staffMember.jobRole,
                            mobileNumber: staffMember.phoneNumber,
                            email: staffMember.user?.email || null,
                            distance: distanceResult.distance,
                            distanceText: distanceResult.distanceText,
                            estimatedTime: distanceResult.duration,
                            estimatedTimeText: distanceResult.durationText,
                            coordinates: staffMember.coordinates,
                            source: distanceResult.source
                        };
                    } catch (error) {
                        console.error(`Error processing staff ${staffMember._id}:`, error.message);
                        return null;
                    }
                })
            );

            // Filter out null results and sort by distance
            const validStaff = staffWithDistance
                .filter(staff => staff !== null)
                .sort((a, b) => a.distance - b.distance);

            console.log('Found', validStaff.length, 'staff within Google Maps API distance');

            // Return complete result
            return {
                hospital: {
                    _id: hospital._id,
                    name: hospital.hospitalLegalName,
                    coordinates: hospital.coordinates
                },
                staff: validStaff,
                filters: {
                    distance: distanceKm,
                    role: role || 'all'
                },
                totalStaffInRange: validStaff.length,
                queryInfo: {
                    hospitalCoords: [hospitalLng, hospitalLat],
                    radiusMeters: distanceKm * 1000,
                    hasRoleFilter: !!role,
                    queryMethod: 'google_maps_api'
                }
            };
        } catch (error) {
            console.error('Error in getNearbyAvailableStaff:', error);
            throw error;
        }
    }

    // GET /api/admin/hospitals-list — simple list with id, name, location (for dropdowns)
    async getHospitalSimpleList(nameFilter = null) {
        const match = {};
        
        if (nameFilter) {
            match.hospitalLegalName = { $regex: nameFilter.trim(), $options: 'i' };
        }

        const hospitals = await Hospital.find(match)
            .select('_id hospitalLegalName location')
            .sort({ hospitalLegalName: 1 })
            .lean();

        return hospitals.map(h => ({
            id: h._id,
            name: h.hospitalLegalName,
            location: h.location
        }));
    }

    // GET /api/admin/hospitals — paginated, filtered hospital list
    async getHospitalList({ search, status, city, page = 1, limit = 10 }) {
        const { skip } = getPaginationParams(page, limit);

        // Build match stage
        const match = {};
        if (status) match.verificationStatus = status;
        if (city) match.location = { $regex: city.trim(), $options: 'i' };
        if (search) {
            const re = { $regex: search.trim(), $options: 'i' };
            match.$or = [{ hospitalLegalName: re }];
            // also allow searching by mongo _id string
            if (mongoose.Types.ObjectId.isValid(search.trim())) {
                match.$or.push({ _id: new mongoose.Types.ObjectId(search.trim()) });
            }
        }

        const pipeline = [
            { $match: match },
            { $sort: { createdAt: -1 } },
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
                    localField: '_id',
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
                                hospitalLegalName: 1,
                                location: 1,
                                currentAddress: 1,
                                staffCount: 1,
                                verificationStatus: '$verificationStatus',
                                rejectionReason: '$rejectionReason',
                                createdAt: 1,
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
        return {
            hospitals: result.data || [],
            pagination: getPaginationMeta(result.totalCount[0]?.count || 0, parseInt(page), parseInt(limit))
        };
    }

    // GET /api/admin/hospitals/:id — preview modal
    async getHospitalDetail(hospitalId) {
        const hospital = await Hospital.findById(hospitalId)
            .populate('user', 'name email createdAt')
            .lean();

        if (!hospital) throw new Error('Hospital not found');

        // Get documents with presigned URLs
        const docRecord = await Document.findOne({ userId: hospital._id }).lean();
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
            location: hospital.location,
            staffCount: hospital.staffCount,
            servicesAvailable: hospital.servicesAvailable,
            verificationStatus: hospital.verificationStatus,
            rejectionReason: hospital.rejectionReason,
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
    }

    // PATCH /api/admin/hospitals/:id/verify
    async verifyHospital(hospitalId) {
        const hospital = await Hospital.findById(hospitalId).populate('user', 'name email');
        if (!hospital) throw new Error('Hospital not found');

        // Allow: pending → verified, rejected → verified
        if (hospital.verificationStatus === 'verified') {
            throw new Error('Hospital is already verified');
        }

        hospital.verificationStatus = 'verified';
        hospital.rejectionReason = null; // clear reason if coming from rejected
        await hospital.save();

        const EmailService = require('./email.service');
        EmailService.sendHospitalVerifiedEmail(hospital.user.email, hospital.hospitalLegalName)
            .catch(err => console.error('Verify email error:', err.message));

        return { id: hospital._id, verificationStatus: hospital.verificationStatus };
    }

    // PATCH /api/admin/hospitals/:id/reject
    async rejectHospital(hospitalId, reason) {
        if (!reason) throw new Error('Rejection reason is required');

        const hospital = await Hospital.findById(hospitalId).populate('user', 'name email');
        if (!hospital) throw new Error('Hospital not found');

        // Allow: pending → rejected only
        // verified → rejected is NOT allowed
        if (hospital.verificationStatus === 'verified') {
            throw new Error('Verified hospital cannot be rejected. Verification is final.');
        }
        if (hospital.verificationStatus === 'rejected') {
            throw new Error('Hospital is already rejected');
        }

        hospital.verificationStatus = 'rejected';
        hospital.rejectionReason = reason;
        await hospital.save();

        const EmailService = require('./email.service');
        EmailService.sendHospitalRejectedEmail(hospital.user.email, hospital.hospitalLegalName, reason)
            .catch(err => console.error('Reject email error:', err.message));

        return { id: hospital._id, verificationStatus: hospital.verificationStatus, rejectionReason: hospital.rejectionReason };
    }

    // GET /api/admin/medical-staff/stats — dashboard stats for medical staff management
    async getMedicalStaffStats() {
        const pipeline = [
            {
                $facet: {
                    // Total staff count
                    totalStaff: [{ $count: 'count' }],
                    
                    // Pending verification count (account level)
                    pendingVerification: [
                        {
                            $match: {
                                verificationStatus: 'pending'
                            }
                        },
                        { $count: 'count' }
                    ],
                    
                    // Approved count (verified accounts)
                    approvedStaff: [
                        {
                            $match: {
                                verificationStatus: 'verified'
                            }
                        },
                        { $count: 'count' }
                    ],
                    
                    // On duty count (staff with in-progress duties)
                    onDutyStaff: [
                        {
                            $lookup: {
                                from: 'duties',
                                localField: '_id',
                                foreignField: 'assignedTo',
                                as: 'duties'
                            }
                        },
                        {
                            $match: {
                                'duties.status': 'in-progress'
                            }
                        },
                        { $count: 'count' }
                    ],
                    
                    // Available/Unavailable counts
                    availabilityStats: [
                        {
                            $group: {
                                _id: '$isAvailable',
                                count: { $sum: 1 }
                            }
                        }
                    ]
                }
            }
        ];

        const [result] = await MedicalStaff.aggregate(pipeline);

        const totalStaff = result.totalStaff[0]?.count || 0;
        const pendingVerification = result.pendingVerification[0]?.count || 0;
        const approvedStaff = result.approvedStaff[0]?.count || 0;
        const onDutyStaff = result.onDutyStaff[0]?.count || 0;

        const availabilityMap = {};
        result.availabilityStats.forEach(s => {
            availabilityMap[s._id] = s.count;
        });

        return {
            totalStaff,
            pendingVerification,
            approvedStaff,
            onDutyStaff,
            totalCount: totalStaff,
            availableCount: availabilityMap[true] || 0,
            unavailableCount: availabilityMap[false] || 0
        };
    }

    // GET /api/admin/medical-staff — paginated list with filters (search, role, availability)
    async getMedicalStaffListWithFilters({ search, role, availability, page = 1, limit = 10 }) {
        const { skip } = getPaginationParams(page, limit);

        // Build match stage
        const match = {};
        
        if (role) match.jobRole = role;
        if (availability !== undefined && availability !== null && availability !== '') {
            match.isAvailable = availability === 'true' || availability === true;
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
                        { fullName: { $regex: search.trim(), $options: 'i' } },
                        { 'userInfo.email': { $regex: search.trim(), $options: 'i' } },
                        { 'userInfo.name': { $regex: search.trim(), $options: 'i' } }
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
                                location: { $concat: ['$area', ', ', '$city'] },
                                email: '$userInfo.email',
                                phoneNumber: 1,
                                completedDuties: { $ifNull: [{ $arrayElemAt: ['$completedDuties.count', 0] }, 0] },
                                isAvailable: 1,
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

        return {
            staff: result.data || [],
            pagination: getPaginationMeta(result.totalCount[0]?.count || 0, parseInt(page), parseInt(limit))
        };
    }

    // GET /api/admin/medical-staff/:staffId — detailed view for review modal
    async getMedicalStaffDetail(staffId) {
        const staff = await MedicalStaff.findById(staffId)
            .populate('user', 'name email createdAt')
            .lean();

        if (!staff) throw new Error('Medical staff not found');

        // Get documents with presigned URLs
        const docRecord = await Document.findOne({ userId: staff._id }).lean();
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
                    extractedData: doc.extractedData,
                    url
                });
            }
        }

        // Get completed duties count
        const completedDuties = await Duty.countDocuments({
            assignedTo: staff._id,
            status: 'completed'
        });

        return {
            id: staff._id,
            userId: staff.user?._id,
            fullName: staff.fullName,
            jobRole: staff.jobRole,
            location: `${staff.area}, ${staff.city}`,
            city: staff.city,
            area: staff.area,
            phoneNumber: staff.phoneNumber,
            email: staff.user?.email,
            profileSummary: staff.profileSummary,
            education: staff.education,
            skills: staff.skills,
            isAvailable: staff.isAvailable,
            isProfileComplete: staff.isProfileComplete,
            verificationStatus: staff.verificationStatus || 'pending',
            rejectionReason: staff.rejectionReason,
            totalExperience: staff.totalExperience || 0,
            averageRating: staff.averageRating,
            totalRatings: staff.totalRatings,
            completedDuties,
            coordinates: {
                latitude: staff.coordinates?.coordinates?.latitude,
                longitude: staff.coordinates?.coordinates?.longitude
            },
            createdAt: staff.createdAt,
            documents
        };
    }

    // PATCH /api/admin/medical-staff/:staffId/verify — verify medical staff account
    async verifyMedicalStaff(staffId) {
        const staff = await MedicalStaff.findById(staffId).populate('user', 'name email');
        if (!staff) throw new Error('Medical staff not found');

        // Check current status
        if (staff.verificationStatus === 'verified') {
            throw new Error('Medical staff is already verified');
        }

        // Update account verification status
        staff.verificationStatus = 'verified';
        staff.rejectionReason = null; // clear any previous rejection reason
        await staff.save();

        // Send email notification
        const EmailService = require('./email.service');
        EmailService.sendMedicalStaffVerifiedEmail(staff.user.email, staff.fullName)
            .catch(err => console.error('Verify email error:', err.message));

        return { 
            id: staff._id, 
            verificationStatus: staff.verificationStatus,
            message: 'Medical staff account verified successfully'
        };
    }

    // PATCH /api/admin/medical-staff/:staffId/reject — reject medical staff account
    async rejectMedicalStaff(staffId, reason) {
        if (!reason) throw new Error('Rejection reason is required');

        const staff = await MedicalStaff.findById(staffId).populate('user', 'name email');
        if (!staff) throw new Error('Medical staff not found');

        // State machine: pending → rejected only (verified cannot be rejected)
        if (staff.verificationStatus === 'verified') {
            throw new Error('Verified medical staff cannot be rejected. Verification is final.');
        }
        if (staff.verificationStatus === 'rejected') {
            throw new Error('Medical staff is already rejected');
        }

        // Update account verification status
        staff.verificationStatus = 'rejected';
        staff.rejectionReason = reason;
        await staff.save();

        // Send email notification
        const EmailService = require('./email.service');
        EmailService.sendMedicalStaffRejectedEmail(staff.user.email, staff.fullName, reason)
            .catch(err => console.error('Reject email error:', err.message));

        return { 
            id: staff._id, 
            verificationStatus: staff.verificationStatus,
            rejectionReason: staff.rejectionReason,
            message: 'Medical staff account rejected'
        };
    }

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
                return { ...rest, url };
            })
        );

        return {
            documents: docsWithUrls,
            pagination: getPaginationMeta(total, parseInt(page), parseInt(limit))
        };
    }

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

    // Get active duties with filtering capabilities
    async getActiveDuties(filters) {
        const { role, location, status, page = 1, limit = 10 } = filters;

        try {
            // Build base query for active duties
            const activeStatuses = ['assigned', 'enroute', 'in-progress'];
            let query = {
                status: status ? [status] : activeStatuses
            };

            // Role-based filtering
            if (role) {
                const allowedRoles = [
                    'rmo', 'dmo', 'general_physician', 'intensivist', 'emergency_doctor',
                    'anesthetist', 'pediatrician', 'gynecologist', 'orthopedic_surgeon',
                    'general_surgeon', 'radiologist', 'pathologist',
                    'staff_nurse', 'icu_nurse', 'emergency_nurse', 'ot_nurse',
                    'dialysis_nurse', 'nicu_nurse',
                    'lab_technician', 'radiology_technician', 'ot_technician',
                    'dialysis_technician', 'cath_lab_technician', 'icu_technician',
                    'ward_boy', 'ayah', 'opd_attendant', 'emergency_attendant',
                    'patient_care_taker',
                    'pharmacist', 'pharmacy_assistant', 'biomedical_engineer',
                    'housekeeping_staff', 'security_guard', 'ambulance_driver',
                    'receptionist', 'billing_executive', 'medical_records_staff', 'hr_accounts'
                ];

                if (!allowedRoles.includes(role)) {
                    throw new Error(`Invalid role: ${role}`);
                }
                query.staffRole = role;
            }

            // Location-based filtering
            if (location) {
                const locationFilter = await this.buildLocationFilter(location);
                if (locationFilter) {
                    query = { ...query, ...locationFilter };
                }
            }

            // Get total count for pagination
            const totalDuties = await Duty.countDocuments(query);

            // Calculate pagination parameters
            const { skip } = getPaginationParams(page, limit);

            // Fetch duties with populated data
            const duties = await Duty.find(query)
                .populate({
                    path: 'assignedTo',
                    select: 'fullName user coordinates',
                    populate: {
                        path: 'user',
                        select: 'name email'
                    }
                })
                .populate('hospital', 'hospitalLegalName location coordinates')
                .sort({ createdAt: -1 }) // Latest duties first
                .skip(skip)
                .limit(limit);

            // Batch process real-time locations for better performance
            const staffUserIds = duties
                .filter(duty => duty.assignedTo && duty.assignedTo.user)
                .map(duty => duty.assignedTo.user._id);

            // Get all real-time locations in batch
            const realtimeLocations = await getBatchStaffLocations(staffUserIds);

            const formattedDuties = await Promise.all(
                duties.map(async (duty) => {
                    return await formatActiveDuty(duty, realtimeLocations);
                })
            );

            return {
                duties: formattedDuties,
                pagination: getPaginationMeta(totalDuties, page, limit),
                filters: {
                    role: role || 'all',
                    location: location || 'all',
                    status: status || 'all'
                },
                summary: {
                    totalActiveDuties: totalDuties,
                    assignedCount: await Duty.countDocuments({ ...query, status: 'assigned' }),
                    enrouteCount: await Duty.countDocuments({ ...query, status: 'enroute' }),
                    inProgressCount: await Duty.countDocuments({ ...query, status: 'in-progress' })
                }
            };
        } catch (error) {
            throw error;
        }
    }



    // Build location filter for city and sub-regions
    async buildLocationFilter(location) {
        try {
            // Normalize location input
            const normalizedLocation = location.toLowerCase().trim();
            
            // Get all hospitals in specified city/region
            const hospitals = await Hospital.find({
                $or: [
                    { location: { $regex: normalizedLocation, $options: 'i' } },
                    { currentAddress: { $regex: normalizedLocation, $options: 'i' } }
                ]
            }).select('_id');

            if (hospitals.length === 0) {
                return null; // No hospitals found in this location
            }

            const hospitalIds = hospitals.map(h => h._id);
            
            return {
                hospital: { $in: hospitalIds }
            };
        } catch (error) {
            console.error('Error building location filter:', error);
            return null;
        }
    }



    // Get duty route map with polyline and real-time tracking
    async getDutyRouteMap(dutyId) {
        try {
            // Redis cache key for optimization
            const cacheKey = `duty_route_map:${dutyId}`;
            const redis = await redisClient.getClientAsync(); // Get the actual Redis client
            const cachedResult = await redis.get(cacheKey);
            
            if (cachedResult) {
                return JSON.parse(cachedResult);
            }

            // Enhanced population with all required fields
            const duty = await Duty.findById(dutyId)
                .populate({
                    path: 'assignedTo',
                    select: 'fullName user coordinates phoneNumber skills averageRating totalExperience city area verificationStatus education profileSummary',
                    populate: {
                        path: 'user',
                        select: 'name email'
                    }
                })
                .populate('hospital', 'hospitalLegalName location currentAddress coordinates')
                .lean(); // Use lean for better performance

            if (!duty) {
                throw new Error('Duty not found');
            }

            // Verify duty is in active state
            if (!['assigned', 'enroute', 'in-progress'].includes(duty.status)) {
                throw new Error('Duty is not in active state');
            }

            if (!duty.assignedTo) {
                throw new Error('Duty is not assigned to any staff');
            }

            const staff = duty.assignedTo;
            const hospital = duty.hospital;

            // Get current staff location with fallback
            const locationTrackingService = require('./locationTracking.service');
            let currentLocation = await locationTrackingService.getStaffLocation(staff.user._id);
            
            // Fallback to staff's registered coordinates if real-time location unavailable
            if (!currentLocation) {
                currentLocation = {
                    latitude: staff.coordinates.coordinates.latitude,
                    longitude: staff.coordinates.coordinates.longitude,
                    timestamp: new Date(),
                    accuracy: null,
                    source: 'registered_address'
                };
            }

            // Enhanced route information with detailed steps
            const geocodingService = require('./geocoding.service');
            let routeInfo = null;

            try {
                routeInfo = await geocodingService.getDirections(
                    currentLocation.latitude,
                    currentLocation.longitude,
                    hospital.coordinates.coordinates.latitude,
                    hospital.coordinates.coordinates.longitude
                );
            } catch (routeError) {
                console.error('Error getting route directions:', routeError);
                // Enhanced fallback with direct distance calculation
                const distance = geocodingService.calculateStraightLineDistance(
                    currentLocation.latitude,
                    currentLocation.longitude,
                    hospital.coordinates.coordinates.latitude,
                    hospital.coordinates.coordinates.longitude
                );
                
                routeInfo = {
                    overviewPolyline: null,
                    stepPolylines: [],
                    distance: distance,
                    duration: null,
                    distanceText: `${distance.toFixed(1)} km`,
                    durationText: null,
                    steps: [],
                    source: 'direct_calculation'
                };
            }

            // Enhanced response with all required fields
            const enhancedResponse = {
                staff: {
                    name: staff.fullName,
                    email: staff.user?.email || null,
                    mobileNumber: staff.phoneNumber,
                    skills: staff.skills || [],
                    avgRating: staff.averageRating || 0,
                    address: `${staff.area}, ${staff.city}`,
                    location: {
                        latitude: currentLocation.latitude,
                        longitude: currentLocation.longitude,
                        lastUpdated: currentLocation.timestamp,
                        accuracy: currentLocation.accuracy || null,
                        source: currentLocation.source || 'realtime'
                    },
                    totalExperience: staff.totalExperience || 0,
                    verificationStatus: staff.verificationStatus,
                    education: staff.education || [],
                    profileSummary: staff.profileSummary || null
                },
                duty: {
                    dutyId: duty._id,
                    dutyRole: duty.staffRole,
                    formattedRole: duty.formattedRole,
                    hospitalName: hospital.hospitalLegalName,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    date: duty.date,
                    endDate: duty.endDate,
                    description: duty.description || null,
                    totalPayment: duty.totalPayment || 0,
                    offeredRate: duty.offeredRate || 0,
                    status: duty.status,
                    urgency: duty.urgency,
                    statusHistory: duty.statusHistory || [],
                    assignedAt: duty.assignedAt,
                    enrouteAt: duty.enrouteAt,
                    startedAt: duty.startedAt,
                    completedAt: duty.completedAt
                },
                hospital: {
                    id: hospital._id,
                    name: hospital.hospitalLegalName,
                    address: hospital.currentAddress,
                    location: hospital.location,
                    coordinates: {
                        latitude: hospital.coordinates.coordinates.latitude,
                        longitude: hospital.coordinates.coordinates.longitude
                    }
                },
                route: {
                    polyline: routeInfo.overviewPolyline,
                    stepPolylines: routeInfo.stepPolylines || [],
                    distance: routeInfo.distance,
                    distanceText: routeInfo.distanceText,
                    duration: routeInfo.duration,
                    durationText: routeInfo.durationText,
                    steps: routeInfo.steps || [],
                    source: routeInfo.source
                },
                tracking: {
                    isRealTime: duty.status === 'enroute' || duty.status === 'in-progress',
                    updateInterval: 2000, // 2 seconds for real-time tracking
                    lastUpdate: currentLocation.timestamp,
                    estimatedArrival: routeInfo.duration ? 
                        new Date(Date.now() + routeInfo.duration * 1000) : null,
                    accuracy: currentLocation.accuracy || null
                },
                metadata: {
                    generatedAt: new Date(),
                    mapType: 'enhanced_route_tracking',
                    source: 'google_maps_api',
                    version: 'v2.0',
                    cacheExpiry: 30 // seconds
                }
            };

            // Cache the result for 30 seconds to optimize for high traffic
            await redis.setex(cacheKey, 30, JSON.stringify(enhancedResponse));

            return enhancedResponse;
        } catch (error) {
            console.error('Error in getDutyRouteMap:', error);
            throw error;
        }
    }


    // GET /api/admin/overnight-duties - Get live overnight duties
    async getOvernightDuties() {
        try {
            const now = new Date();
            
            // Query for overnight duties that are currently active
            const overnightDuties = await Duty.find({
                isOvernightDuty: true,
                status: { $in: ['assigned', 'enroute', 'in-progress'] },
                date: { $lte: now } // Started today or earlier
            })
            .populate({
                path: 'assignedTo',
                select: 'fullName jobRole user',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .populate('hospital', 'hospitalLegalName location')
            .sort({ startTime: 1 })
            .lean();

            // Format the duties with remaining time calculation
            const formattedDuties = overnightDuties.map(duty => {
                const staff = duty.assignedTo;
                const hospital = duty.hospital;
                
                // Calculate remaining time
                const dutyDate = new Date(duty.date);
                const [endHours, endMinutes] = duty.endTime.split(':');
                const dutyEndTime = new Date(dutyDate);
                dutyEndTime.setHours(parseInt(endHours), parseInt(endMinutes), 0, 0);
                
                // If overnight, end time is next day
                if (duty.isOvernightDuty) {
                    dutyEndTime.setDate(dutyEndTime.getDate() + 1);
                }
                
                const remainingMs = dutyEndTime - now;
                const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
                const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
                
                // Determine current load status based on duty status and time
                let currentLoad = 'Optimal';
                if (duty.status === 'in-progress') {
                    if (remainingHours < 2) {
                        currentLoad = 'High';
                    } else if (remainingHours < 4) {
                        currentLoad = 'Moderate';
                    }
                } else if (duty.status === 'assigned') {
                    currentLoad = 'On-Call';
                }
                
                return {
                    id: duty._id,
                    staffName: staff?.fullName || 'Unknown',
                    staffRole: duty.staffRole,
                    formattedRole: duty.formattedRole,
                    hospitalName: hospital?.hospitalLegalName || 'Unknown',
                    hospitalLocation: hospital?.location || 'Unknown',
                    ward: duty.description || 'General Ward',
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    timeRange: `${duty.startTime} - ${duty.endTime}`,
                    remainingTime: remainingHours > 0 
                        ? `${remainingHours}h ${remainingMinutes}m remaining`
                        : `${remainingMinutes}m remaining`,
                    currentLoad,
                    status: duty.status,
                    date: duty.date
                };
            });

            return {
                duties: formattedDuties,
                count: formattedDuties.length
            };
        } catch (error) {
            console.error('Error in getOvernightDuties:', error);
            throw error;
        }
    }


    // GET /api/admin/duty-history - Get completed duty history with filters
    async getDutyHistory({ date, startDate, endDate, hospitalName, page = 1, limit = 10 }) {
        try {
            // Build query - start with completed status only
            const query = {
                status: 'completed'
            };
            
            // Build date filter
            let dateFilter;
            if (date || startDate || endDate) {
                // Use provided date filters
                dateFilter = this.buildDateFilter(startDate, endDate, date);
            } else {
                // Default: last 7 days (1 week)
                const today = new Date();
                const oneWeekAgo = new Date(today);
                oneWeekAgo.setDate(today.getDate() - 7);
                
                dateFilter = {
                    $gte: new Date(oneWeekAgo.getFullYear(), oneWeekAgo.getMonth(), oneWeekAgo.getDate()),
                    $lt: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
                };
            }
            
            // Use $or to check both completedAt and date fields
            // This handles cases where completedAt might not be set
            query.$or = [
                { completedAt: dateFilter },
                { date: dateFilter }
            ];
            
            // Add hospital name filter if provided
            let hospitalIds = null;
            if (hospitalName) {
                const hospitals = await Hospital.find({
                    hospitalLegalName: { $regex: hospitalName.trim(), $options: 'i' }
                }).select('_id');
                
                if (hospitals.length === 0) {
                    // No hospitals found with this name
                    return {
                        duties: [],
                        pagination: {
                            currentPage: page,
                            totalPages: 0,
                            totalItems: 0,
                            itemsPerPage: limit,
                            hasNextPage: false,
                            hasPrevPage: false
                        },
                        filters: {
                            date: date || null,
                            startDate: startDate || null,
                            endDate: endDate || null,
                            hospitalName: hospitalName || null
                        }
                    };
                }
                
                hospitalIds = hospitals.map(h => h._id);
                query.hospital = { $in: hospitalIds };
            }
            
            // Get total count for pagination
            const totalDuties = await Duty.countDocuments(query);
            
            // Calculate pagination
            const { skip } = getPaginationParams(page, limit);
            
            // Fetch duties - sort by completedAt if available, otherwise by date
            const duties = await Duty.find(query)
                .populate({
                    path: 'assignedTo',
                    select: 'fullName jobRole user',
                    populate: {
                        path: 'user',
                        select: 'name email'
                    }
                })
                .populate('hospital', 'hospitalLegalName location')
                .sort({ completedAt: -1, date: -1 })
                .skip(skip)
                .limit(limit)
                .lean();
            
            // Format duties
            const formattedDuties = duties.map(duty => {
                const staff = duty.assignedTo;
                const hospital = duty.hospital;
                
                // Calculate hours completed
                const duration = formatDuration(
                    duty.startTime,
                    duty.endTime,
                    duty.date,
                    duty.isOvernightDuty,
                    duty.endDate
                );
                
                return {
                    id: duty._id,
                    staffName: staff?.fullName || 'Unknown',
                    staffEmail: staff?.user?.email || null,
                    staffRole: duty.staffRole,
                    formattedRole: duty.formattedRole,
                    department: duty.description || 'General',
                    hospitalName: hospital?.hospitalLegalName || 'Unknown',
                    hospitalLocation: hospital?.location || 'Unknown',
                    shiftDuration: duration,
                    hoursCompleted: calculateDutyDuration(
                        duty.date,
                        duty.startTime,
                        duty.endTime,
                        duty.isOvernightDuty,
                        duty.endDate
                    ),
                    date: duty.date,
                    completedAt: duty.completedAt,
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    timeRange: `${duty.startTime} - ${duty.endTime}`,
                    status: 'COMPLETED',
                    totalPayment: duty.totalPayment,
                    offeredRate: duty.offeredRate
                };
            });
            
            return {
                duties: formattedDuties,
                pagination: getPaginationMeta(totalDuties, page, limit),
                filters: {
                    date: date || null,
                    startDate: startDate || null,
                    endDate: endDate || null,
                    hospitalName: hospitalName || null
                }
            };
        } catch (error) {
            console.error('Error in getDutyHistory:', error);
            throw error;
        }
    }
}

module.exports = new AdminService();