const MedicalStaff = require('../models/MedicalStaff');
const Duty = require('../models/Duty');
const { getCurrentIST } = require('../utils/helpers');

class DashboardService {
    // Get staff overview with profile and basic stats
    async getStaffOverview(userId) {

        const medicalStaff = await MedicalStaff.findOne({ user: userId });

        if (!medicalStaff) {
            throw new Error('Medical staff profile not found');
        }

        const stats = await this.getStaffStats(medicalStaff._id);
        const recentDuties = await this.getRecentDuties(medicalStaff._id);

        return {
            profile: {
                ...medicalStaff.toObject(),
                rating: {
                    averageRating: medicalStaff.averageRating,
                    totalRatings: medicalStaff.totalRatings
                }
            },
            stats,
            recentDuties
        };
    }


    // Get comprehensive staff statistics
    async getStaffStats(staffId) {
        const now = getCurrentIST();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [
            totalDuties,
            completedDuties,
            upcomingDuties,
            ongoingDuties,
            thisMonthDuties,
            thisMonthCompleted
        ] = await Promise.all([
            Duty.countDocuments({ assignedTo: staffId }),
            Duty.countDocuments({ assignedTo: staffId, status: 'completed' }),
            Duty.countDocuments({ assignedTo: staffId, status: 'assigned', date: { $gte: today } }),
            Duty.countDocuments({ assignedTo: staffId, status: { $in: ['assigned', 'enroute', 'in-progress'] } }),
            Duty.countDocuments({ assignedTo: staffId, createdAt: { $gte: thisMonth } }),
            Duty.countDocuments({ assignedTo: staffId, status: 'completed', completedAt: { $gte: thisMonth } })
        ]);

        return {
            totalDuties,
            completedDuties,
            upcomingDuties,
            ongoingDuties,
            thisMonthDuties,
            thisMonthCompleted,
            completionRate: totalDuties > 0 ? (completedDuties / totalDuties * 100).toFixed(1) : '0.0',
            monthlyCompletionRate: thisMonthDuties > 0 ? (thisMonthCompleted / thisMonthDuties * 100).toFixed(1) : '0.0'
        };
    }


    // Get recent duties for dashboard
    async getRecentDuties(staffId, limit = 5) {
        return await Duty.find({ assignedTo: staffId })
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .sort({ createdAt: -1 })
            .limit(limit);
    }


    // Get upcoming duties with details
    async getUpcomingDuties(userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new Error('Medical staff profile not found');
        }

        const now = getCurrentIST();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const duties = await Duty.find({
            assignedTo: medicalStaff._id,
            status: 'assigned',
            date: { $gte: today }
        })
            .populate({
                path: 'hospital',
                populate: {
                    path: 'user',
                    select: 'name email'
                }
            })
            .sort({ date: 1, startTime: 1 })
            .limit(10);

        return duties;
    }


    // Get earnings information
    async getEarnings(staffId) {
        const completedDuties = await Duty.find({
            assignedTo: staffId,
            status: 'completed'
        }).select('totalPayment completedAt');

        const totalEarnings = completedDuties.reduce((sum, duty) => sum + (duty.totalPayment || 0), 0);

        return {
            totalEarnings: totalEarnings,
            completedDutiesCount: completedDuties.length,
            averagePerDuty: completedDuties.length > 0 ? (totalEarnings / completedDuties.length).toFixed(2) : '0.0'
        };
    }


    // Get availability status
    async getAvailabilityStatus(userId) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            throw new Error('Medical staff profile not found');
        }

        return {
            isAvailable: medicalStaff.isAvailable,
            profileComplete: medicalStaff.isProfileComplete,
            lastUpdated: medicalStaff.updatedAt
        };
    }
}

module.exports = new DashboardService();