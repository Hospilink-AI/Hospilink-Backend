// Admin: dashboard and summary statistics
// Methods of AdminService; mixed into the class in ../admin.service.js, so `this` is the service.
const Duty = require('../../models/Duty');
const MedicalStaff = require('../../models/MedicalStaff');
const Hospital = require('../../models/Hospital');

module.exports = {
    // GET /api/admin/dashboard-stats - Get dashboard overview statistics
    async getDashboardStats() {
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
    },

    // Get staff statistics grouped by job role
    async getStaffStatistics() {
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
    },

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
    },

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
};
