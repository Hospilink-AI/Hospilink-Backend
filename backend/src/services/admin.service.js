const mongoose = require('mongoose');
const Duty = require('../models/Duty');
const MedicalStaff = require('../models/MedicalStaff');
const Hospital = require('../models/Hospital');
const Review = require('../models/Review');
const Document = require('../models/Document');
const User = require('../models/User');
const { generatePreSignedURL } = require('./s3.service');
const { calculateDutyDuration, getCurrentIST, formatDuration, formatRoleForDisplay} = require('../utils/helpers');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const { ALLOWED_ROLES } = require('../utils/constants');
const geocodingService = require('./geocoding.service');
const locationTrackingService = require('./locationTracking.service');
const redisClient = require('../config/redis');
const { getBatchStaffLocations, formatActiveDuty } = require('../utils/activeDuty.helper');
const EmailService = require('./email.service');
const CacheInvalidationService = require('./cacheInvalidation.service');
const cacheService = require('./cache.service');
const logger = require('../utils/logger');
const notificationEmitter = require('./notificationEmitter');
const DashboardService = require('./dashboard.service');
const {
    ValidationError,
    NotFoundError,
    ConflictError
} = require('../middleware/error.middleware');

/**
 * Escape all special regex characters in a user-supplied string before
 * passing it to a MongoDB $regex query. Prevents ReDoS attacks where a
 * crafted pattern like (a+)+$ causes catastrophic backtracking.
 */
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');



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
                throw new ValidationError('Invalid date format. Use DD-MM-YYYY format');
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
                throw new ValidationError('Invalid date format. Use DD-MM-YYYY format');
            }

            if (start > end) {
                throw new ValidationError('Start date must be before or equal to end date');
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
                .select('fullName jobRole currentAddress city state pincode phoneNumber coordinates isAvailable averageRating verificationStatus user')
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

            // Combine staff with distance results
            const staffWithRealTimeLocation = validStaffWithLocations.map(s => {
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
                    rating: s.staff.averageRating || 0,
                    isAvailable: s.staff.isAvailable,
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
    }



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
    }



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
                                hospitalLegalName: 1,
                                currentAddress: 1,
                                city: 1,
                                state: 1,
                                pincode: 1,
                                staffCount: 1,
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
    }


    // GET /api/admin/hospitals/:id — preview modal
    async getHospitalDetail(hospitalId) {
        const hospital = await Hospital.findById(hospitalId)
            .populate('user', 'name email createdAt')
            .lean();

        if (!hospital) throw new NotFoundError('Hospital not found');

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
    }

    

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
    }



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



    // GET /api/admin/hospitals/stats — dashboard stats for hospital management
    async getHospitalStats() {
        const pipeline = [
            {
                $facet: {
                    // Total hospital count
                    totalHospitals: [{ $count: 'count' }],
                    
                    // Pending verification count
                    pendingVerification: [
                        {
                            $match: {
                                verificationStatus: 'pending'
                            }
                        },
                        { $count: 'count' }
                    ],
                    
                    // Verified hospitals count
                    verifiedHospitals: [
                        {
                            $match: {
                                verificationStatus: 'verified'
                            }
                        },
                        { $count: 'count' }
                    ]
                }
            }
        ];
 
        const [result] = await Hospital.aggregate(pipeline);
 
        const totalHospitals = result.totalHospitals[0]?.count || 0;
        const pendingVerification = result.pendingVerification[0]?.count || 0;
        const verifiedHospitals = result.verifiedHospitals[0]?.count || 0;
 
        return {
            totalHospitals,
            pendingVerification,
            verifiedHospitals
        };
    }

    

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
    }



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
    }



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
        if (!staff) throw new NotFoundError('Medical staff not found');

        // Allow: pending → verified, rejected → verified
        if (staff.verificationStatus === 'verified') {
            throw new ConflictError('Medical staff is already verified');
        }

        const previousStatus = staff.verificationStatus;
        staff.verificationStatus = 'verified';
        staff.rejectionReason = null; // clear reason if coming from rejected
        staff.isAvailable = true; // Auto-enable availability when verified
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
    }

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
                if (!ALLOWED_ROLES.includes(role)) {
                    throw new ValidationError(`Invalid role: ${role}`);
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

            // Get total count for pagination (before filtering)
            const totalDuties = await Duty.countDocuments(query);

            // Calculate pagination parameters
            const { skip } = getPaginationParams(page, limit);

            // Fetch duties with populated data
            const duties = await Duty.find(query)
                .populate({
                    path: 'assignedTo',
                    select: 'fullName user coordinates currentAddress city state pincode email',
                    populate: {
                        path: 'user',
                        select: 'name email'
                    }
                })
                .populate('hospital', 'hospitalLegalName currentAddress city state pincode coordinates')
                .sort({ createdAt: -1 }) // Latest duties first
                .skip(skip)
                .limit(limit);

            // Filter out duties with missing staff data before processing
            const validDuties = duties.filter(duty => duty.assignedTo);

            // Batch process real-time locations for better performance
            const staffUserIds = validDuties
                .filter(duty => duty.assignedTo && duty.assignedTo.user)
                .map(duty => duty.assignedTo.user._id);

            // Get all real-time locations in batch
            const realtimeLocations = await getBatchStaffLocations(staffUserIds);

            const formattedDuties = await Promise.all(
                validDuties.map(async (duty) => {
                    return await formatActiveDuty(duty, realtimeLocations);
                })
            );

            // Filter out null results from duties with missing staff
            const validFormattedDuties = formattedDuties.filter(duty => duty !== null);

            return {
                duties: validFormattedDuties,
                pagination: getPaginationMeta(validFormattedDuties.length, page, limit),
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
            const normalizedLocation = escapeRegex(location.toLowerCase().trim());
            
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
                    select: 'fullName user coordinates phoneNumber skills averageRating experience currentAddress city state pincode email verificationStatus education profileSummary',
                    populate: {
                        path: 'user',
                        select: 'name email'
                    }
                })
                .populate('hospital', 'hospitalLegalName currentAddress city state pincode coordinates')
                .lean(); // Use lean for better performance

            if (!duty) {
                throw new NotFoundError('Duty not found');
            }

            // Verify duty is in active state
            if (!['assigned', 'enroute', 'in-progress'].includes(duty.status)) {
                throw new ValidationError('Duty is not in active state');
            }

            if (!duty.assignedTo) {
                throw new ValidationError('Duty is not assigned to any staff');
            }

            const staff = duty.assignedTo;
            const hospital = duty.hospital;

            // Get current staff location with fallback
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
                // Fallback: set routeInfo to null when directions API fails
                routeInfo = {
                    overviewPolyline: null,
                    stepPolylines: [],
                    distance: null,
                    duration: null,
                    distanceText: null,
                    durationText: null,
                    steps: [],
                    source: 'error'
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
                    currentAddress: staff.currentAddress,
                    city: staff.city,
                    state: staff.state,
                    pincode: staff.pincode,
                    location: {
                        latitude: currentLocation.latitude,
                        longitude: currentLocation.longitude,
                        lastUpdated: currentLocation.timestamp,
                        accuracy: currentLocation.accuracy || null,
                        source: currentLocation.source || 'realtime'
                    },
                    experience: staff.experience,
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
                    city: hospital.city,
                    state: hospital.state,
                    pincode: hospital.pincode,
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
                    hospitalLegalName: { $regex: escapeRegex(hospitalName.trim()), $options: 'i' }
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
                .populate('hospital', 'hospitalLegalName currentAddress city state pincode')
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
                    hospitalLocation: hospital?.currentAddress ? {
                        currentAddress: hospital.currentAddress,
                        city: hospital.city,
                        state: hospital.state,
                        pincode: hospital.pincode
                    } : null,
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


    
    // Create duty for hospital from admin panel
    // POST /api/admin/duties
    async createDutyForHospital(hospitalId, dutyPayload) {
        const {
            staff_role,
            date,
            end_date,
            start_time,
            end_time,
            urgency,
            description,
            offered_rate,
            is_overnight_duty,
            staff_count,
            duty_sub_type
        } = dutyPayload;

        // Fetch and validate hospital
        const hospital = await Hospital.findById(hospitalId)
            .select('hospitalLegalName currentAddress city state pincode coordinates servicesAvailable staffCount isProfileComplete verificationStatus user')
            .populate('user', '_id name');

        if (!hospital) {
            const error = new Error('Hospital not found');
            error.statusCode = 404;
            throw error;
        }

        // Check hospital verification status
        if (hospital.verificationStatus !== 'verified') {
            const statusMessages = {
                pending: 'Cannot create duty: hospital verification is still pending.',
                rejected: 'Cannot create duty: hospital has been rejected and is not verified.'
            };
            const message = statusMessages[hospital.verificationStatus] || 'Cannot create duty: hospital is not verified.';
            const error = new Error(message);
            error.statusCode = 403;
            throw error;
        }

        // Determine number of duties to create (default to 1 if staff_count not provided)
        const numberOfDuties = staff_count ? parseInt(staff_count) : 1;

        const dutyData = {
            staffRole: staff_role,
            date,
            endDate: end_date,
            startTime: start_time,
            endTime: end_time,
            urgency,
            description,
            offeredRate: offered_rate,
            isOvernightDuty: is_overnight_duty || false,
            ...(staff_role === 'rmo' && { dutySubType: duty_sub_type })
        };

        // Create multiple duties based on staff_count
        const createdDuties = [];
        for (let i = 0; i < numberOfDuties; i++) {
            // Use the hospital's own user ID so existing service logic works unchanged
            const DutyService = require('./duty.service');
            const result = await DutyService.createDuty(dutyData, hospital.user._id);
            createdDuties.push(result.duty);
        }

        // Notify matching staff + hospital (same as hospital flow)
        try {
            const matchingStaff = await MedicalStaff.find({
                jobRole: staff_role,
                isAvailable: true
            }).populate('user', '_id');

            // Filter out staff with null user references and map to user IDs
            const staffUserIds = matchingStaff
                .filter(s => s.user && s.user._id)
                .map(s => s.user._id.toString());

            const hospitalUserId = hospital.user._id.toString();

            // Send notifications for all created duties
            for (const duty of createdDuties) {
                await notificationEmitter.emitDutyCreated(duty, hospital, staffUserIds, hospitalUserId);
            }

            // Notify all admins if this is an emergency duty
            if (urgency === 'emergency') {
                const admins = await User.find({ role: 'admin' }).select('_id');
                if (admins.length) {
                    const adminIds = admins.map(a => a._id.toString());
                    
                    // Send emergency alerts for all created duties
                    for (const duty of createdDuties) {
                        await notificationEmitter.emitEmergencyAdminAlert(duty, hospital, adminIds, 'emergency_created');

                        const alertEmail = process.env.ADMIN_LOGIN_ALERT_EMAIL;
                        if (alertEmail) {
                            require('./email.service').sendEmergencyAdminAlertEmail(
                                alertEmail, 'Admin', duty, hospital, 'emergency_created'
                            ).catch(err => logger.error(`Error sending emergency alert email: ${err.message}`));
                        }
                    }
                }
            }
        } catch (err) {
            logger.error('Admin createDuty: notification error - ' + err.message);
        }

        return {
            success: true,
            duties: createdDuties,
            count: createdDuties.length,
            message: `Successfully created ${createdDuties.length} ${createdDuties.length === 1 ? 'duty' : 'duties'}`
        };
    }

    // ─── Account suspension ────────────────────────────────────────────────────

    // PATCH /api/admin/hospitals/:hospitalId/suspend
    async suspendHospital(hospitalId, reason) {
        if (!reason) throw new ValidationError('Suspension reason is required');

        const hospital = await Hospital.findById(hospitalId).populate('user', 'name email');
        if (!hospital) throw new NotFoundError('Hospital not found');

        if (hospital.isSuspended) {
            throw new ConflictError('Hospital account is already suspended');
        }

        hospital.isSuspended = true;
        hospital.suspensionReason = reason;
        hospital.suspendedAt = new Date();
        await hospital.save();

        const userId = hospital.user._id;

        // Invalidate all relevant caches immediately
        await Promise.allSettled([
            CacheInvalidationService.invalidateHospitalSuspensionCache(userId),
            CacheInvalidationService.invalidateHospitalVerificationCache(userId),
            cacheService.invalidateUserProfiles(userId.toString()),
            cacheService.invalidateProfileStatus(userId.toString()),
            cacheService.del(`session:${userId}`)
        ]);

        // Re-warm the suspension cache so the next request hits cache, not DB
        await CacheInvalidationService.refreshHospitalSuspensionCache(userId);

        logger.info(`Hospital ${hospitalId} suspended. Reason: ${reason}`);

        // Fire-and-forget: email + notification
        EmailService.sendAccountSuspendedEmail(hospital.user.email, hospital.hospitalLegalName, reason)
            .catch(err => logger.error('Suspension email error:', err.message));

        notificationEmitter.emitAccountSuspended(hospital, userId.toString(), 'hospital', reason)
            .catch(err => logger.error('Suspension notification error:', err.message));

        return {
            id: hospital._id,
            isSuspended: hospital.isSuspended,
            suspensionReason: hospital.suspensionReason,
            suspendedAt: hospital.suspendedAt,
            message: 'Hospital account suspended successfully'
        };
    }

    // PATCH /api/admin/hospitals/:hospitalId/unsuspend
    async unsuspendHospital(hospitalId) {
        const hospital = await Hospital.findById(hospitalId).populate('user', 'name email');
        if (!hospital) throw new NotFoundError('Hospital not found');

        if (!hospital.isSuspended) {
            throw new ConflictError('Hospital account is not currently suspended');
        }

        hospital.isSuspended = false;
        hospital.suspensionReason = null;
        hospital.suspendedAt = null;
        await hospital.save();

        const userId = hospital.user._id;

        await Promise.allSettled([
            CacheInvalidationService.invalidateHospitalSuspensionCache(userId),
            CacheInvalidationService.invalidateHospitalVerificationCache(userId),
            cacheService.invalidateUserProfiles(userId.toString()),
            cacheService.invalidateProfileStatus(userId.toString()),
            cacheService.del(`session:${userId}`)
        ]);

        await CacheInvalidationService.refreshHospitalSuspensionCache(userId);

        logger.info(`Hospital ${hospitalId} unsuspended`);

        EmailService.sendAccountActivatedEmail(hospital.user.email, hospital.hospitalLegalName)
            .catch(err => logger.error('Unsuspend email error:', err.message));

        notificationEmitter.emitAccountActivated(hospital, userId.toString(), 'hospital')
            .catch(err => logger.error('Unsuspend notification error:', err.message));

        return {
            id: hospital._id,
            isSuspended: hospital.isSuspended,
            suspensionReason: hospital.suspensionReason,
            message: 'Hospital account unsuspended successfully'
        };
    }

    // PATCH /api/admin/medical-staff/:staffId/suspend
    async suspendMedicalStaff(staffId, reason) {
        if (!reason) throw new ValidationError('Suspension reason is required');

        const staff = await MedicalStaff.findById(staffId).populate('user', 'name email');
        if (!staff) throw new NotFoundError('Medical staff not found');

        if (staff.isSuspended) {
            throw new ConflictError('Staff account is already suspended');
        }

        staff.isSuspended = true;
        staff.suspensionReason = reason;
        staff.suspendedAt = new Date();
        await staff.save();

        const userId = staff.user._id;

        await Promise.allSettled([
            CacheInvalidationService.invalidateStaffSuspensionCache(userId),
            CacheInvalidationService.invalidateStaffVerificationCache(userId),
            cacheService.invalidateUserProfiles(userId.toString()),
            cacheService.invalidateProfileStatus(userId.toString()),
            cacheService.del(`session:${userId}`),
            cacheService.del(`staff_availability:${userId}`)
        ]);

        await CacheInvalidationService.refreshStaffSuspensionCache(userId);

        logger.info(`Medical staff ${staffId} suspended. Reason: ${reason}`);

        EmailService.sendAccountSuspendedEmail(staff.user.email, staff.fullName, reason)
            .catch(err => logger.error('Suspension email error:', err.message));

        notificationEmitter.emitAccountSuspended(staff, userId.toString(), 'staff', reason)
            .catch(err => logger.error('Suspension notification error:', err.message));

        return {
            id: staff._id,
            isSuspended: staff.isSuspended,
            suspensionReason: staff.suspensionReason,
            suspendedAt: staff.suspendedAt,
            message: 'Staff account suspended successfully'
        };
    }

    // PATCH /api/admin/medical-staff/:staffId/unsuspend
    async unsuspendMedicalStaff(staffId) {
        const staff = await MedicalStaff.findById(staffId).populate('user', 'name email');
        if (!staff) throw new NotFoundError('Medical staff not found');

        if (!staff.isSuspended) {
            throw new ConflictError('Staff account is not currently suspended');
        }

        staff.isSuspended = false;
        staff.suspensionReason = null;
        staff.suspendedAt = null;
        await staff.save();

        const userId = staff.user._id;

        await Promise.allSettled([
            CacheInvalidationService.invalidateStaffSuspensionCache(userId),
            CacheInvalidationService.invalidateStaffVerificationCache(userId),
            cacheService.invalidateUserProfiles(userId.toString()),
            cacheService.invalidateProfileStatus(userId.toString()),
            cacheService.del(`session:${userId}`),
            cacheService.del(`staff_availability:${userId}`)
        ]);

        await CacheInvalidationService.refreshStaffSuspensionCache(userId);

        logger.info(`Medical staff ${staffId} unsuspended`);

        EmailService.sendAccountActivatedEmail(staff.user.email, staff.fullName)
            .catch(err => logger.error('Unsuspend email error:', err.message));

        notificationEmitter.emitAccountActivated(staff, userId.toString(), 'staff')
            .catch(err => logger.error('Unsuspend notification error:', err.message));

        return {
            id: staff._id,
            isSuspended: staff.isSuspended,
            suspensionReason: staff.suspensionReason,
            message: 'Staff account unsuspended successfully'
        };
    }




    // Admin overrides duty status
    async adminOverrideDutyStatus(dutyId, adminUserId, newStatus, reason) {
        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        const allowedTransitions = {
            'available': ['assigned', 'enroute', 'in-progress', 'completed'],
            'assigned': ['available', 'enroute', 'in-progress', 'completed'],
            'enroute': ['available', 'assigned', 'in-progress', 'completed'],
            'in-progress': ['completed'],
            'pending-confirmation': ['completed'],
            'completed': []
        };

        if (!allowedTransitions[duty.status]) {
            throw new ValidationError(`Admin override is not allowed from status ${duty.status}`);
        }

        if (!allowedTransitions[duty.status].includes(newStatus)) {
            throw new ValidationError(`Invalid override transition from ${duty.status} to ${newStatus}`);
        }

        const previousStatus = duty.status;
        duty.status = newStatus;
        duty.statusHistory.push({
            status: newStatus,
            timestamp: getCurrentIST(),
            changedBy: adminUserId,
            reason,
            manualOverride: true,
            overriddenFromStatus: previousStatus
        });

        await duty.save();

        await duty.populate({
            path: 'assignedTo',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        await duty.populate({
            path: 'hospital',
            populate: {
                path: 'user',
                select: 'name email'
            }
        });

        return duty;
    }




    // Admin unlocks a locked start/end OTP
    async unlockDutyOtp(dutyId, otpType, adminId, reason) {
        if (!['start', 'end'].includes(otpType)) {
            throw new ValidationError("otpType must be 'start' or 'end'");
        }

        const field = `${otpType}Otp`;

        const duty = await Duty.findById(dutyId);
        if (!duty) {
            throw new NotFoundError('Duty not found');
        }

        if (duty[field].status !== 'LOCKED') {
            throw new ValidationError(`${otpType === 'start' ? 'Start' : 'End'} OTP is not locked`);
        }

        const now = getCurrentIST();
        const updated = await Duty.findOneAndUpdate(
            { _id: dutyId, [`${field}.status`]: 'LOCKED' },
            {
                $set: {
                    [`${field}.status`]: 'NONE',
                    [`${field}.attempts`]: 0,
                    [`${field}.unlockedBy`]: adminId,
                    [`${field}.unlockReason`]: reason
                },
                $push: {
                    statusHistory: {
                        status: duty.status,
                        timestamp: now,
                        changedBy: adminId,
                        reason: `${otpType === 'start' ? 'Start' : 'End'} OTP unlocked by admin: ${reason}`
                    }
                }
            },
            { new: true }
        );

        if (!updated) {
            throw new ConflictError('OTP status changed — cannot unlock');
        }

        return updated;
    }
}

module.exports = new AdminService();
