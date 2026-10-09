// Duties: a doctor's completed duties, totals and statement PDF
// Methods of DutyService; mixed into the class in ../duty.service.js, so `this` is the service.
const Duty = require('../../models/Duty');
const MedicalStaff = require('../../models/MedicalStaff');
const { formatDuration } = require('../../utils/helpers');
const { getPaginationParams, getPaginationMeta } = require('../../utils/pagination');
const { istDayStart, addDaysToKey } = require('../../utils/calendar.helper');
const User = require('../../models/User');
const {
    generateEarningsPDF,
    generateDutyReceiptPDF
} = require('../../utils/pdf.puppeteer');
const reviewService = require('../review.service');
const { ValidationError, NotFoundError } = require('../../middleware/error.middleware');
const { EARNINGS_DUTY_FIELDS, paymentStatusOf, dutyHours } = require('./helpers');

module.exports = {
    async getCompletedDutiesForStaff(staffUserId, page = 1, limit = 10, statusFilter = null) {
        const TERMINAL_STATUSES = ['completed', 'cancelled', 'incomplete'];

        if (statusFilter && !TERMINAL_STATUSES.includes(statusFilter)) {
            throw new ValidationError(`Invalid status filter. Allowed values: ${TERMINAL_STATUSES.join(', ')}`);
        }

        const staff = await MedicalStaff.findOne({ user: staffUserId });
        if (!staff) {
            throw new NotFoundError('Medical staff profile not found');
        }

        const paginationParams = getPaginationParams(page, limit);

        const statusQuery = statusFilter ? statusFilter : { $in: TERMINAL_STATUSES };

        // Summary covers every completed duty, not just this page
        const totalsPromise = this._completedTotals(staff._id);
        totalsPromise.catch(() => {}); // awaited below; avoids an unhandled rejection if a query before it fails

        const totalDuties = await Duty.countDocuments({
            assignedTo: staff._id,
            status: statusQuery
        });

        const duties = await Duty.find({
            assignedTo: staff._id,
            status: statusQuery
        })
            .populate('hospital', 'hospitalLegalName currentAddress city state pincode')
            .populate({
                path: 'assignedTo',
                populate: {
                    path: 'user',
                    select: 'name email role'
                }
            })
            .sort({ completedAt: -1, cancelledAt: -1, expiredAt: -1, incompleteAt: -1 })
            .skip(paginationParams.skip)
            .limit(paginationParams.limit);

        // Blind/simultaneous reveal (Phase 3) — one batched call, not
        // one per duty (same lesson as the rating algorithm's own
        // batching). Replaces the old reviewMap, which keyed only by
        // duty id — when both directions existed for a duty, the
        // second one processed silently overwrote the first.
        const dutyIds = duties.map(duty => duty._id);
        const visibleReviewPairs = await reviewService.getVisibleReviewPairsForDuties(dutyIds, 'staff');

        const totals = await totalsPromise;
        let lastDutyDate = null;

        const dutiesWithDetails = duties.map(duty => {
            // Use the most relevant status timestamp for lastDutyDate
            const dutyTimestamp = duty.completedAt || duty.cancelledAt || duty.expiredAt || duty.incompleteAt;
            if (!lastDutyDate || dutyTimestamp > lastDutyDate) {
                lastDutyDate = dutyTimestamp;
            }

            return {
                _id: duty._id,
                hospital: duty.hospital,
                assignedTo: duty.assignedTo,
                staffRole: duty.staffRole,
                dutySubType: duty.dutySubType,
                status: duty.status,
                date: duty.date,
                endDate: duty.endDate,
                startTime: duty.startTime,
                endTime: duty.endTime,
                isOvernightDuty: duty.isOvernightDuty,
                urgency: duty.urgency,
                description: duty.description,
                offeredRate: duty.offeredRate,
                totalPayment: duty.totalPayment,
                paymentMethod: duty.paymentMethod || null,
                isPaid: typeof duty.isPaid === 'boolean' ? duty.isPaid : null,
                paymentStatus: duty.status === 'completed' ? paymentStatusOf(duty) : null,
                duration: formatDuration(
                    duty.startTime,
                    duty.endTime,
                    duty.date,
                    duty.isOvernightDuty,
                    duty.endDate
                ),
                assignedAt: duty.assignedAt,
                completedAt: duty.completedAt || null,
                cancelledAt: duty.cancelledAt || null,
                expiredAt: duty.expiredAt || null,
                incompleteAt: duty.incompleteAt || null,
                cancellation: duty.cancellation || null,
                statusHistory: duty.statusHistory,
                // rating = the staff's own submitted review (always
                // visible — they wrote it); hospitalReview = the
                // hospital's review of them, gated until both sides
                // exist or the reveal timeout passes.
                rating: visibleReviewPairs.get(duty._id.toString())?.staffToHospital || null,
                hospitalReview: visibleReviewPairs.get(duty._id.toString())?.hospitalToStaff || null
            };
        });

        return {
            summary: {
                totalDutiesCompleted: totals.count,
                totalHours: formatDuration(totals.hours),
                totalEarnings: totals.earnings,
                lastDutyDate: lastDutyDate,
                paidEarnings: totals.paid,
                pendingEarnings: totals.pending
            },
            duties: dutiesWithDetails,
            pagination: getPaginationMeta(totalDuties, page, limit)
        };

    },

    // Earnings over every completed duty of a doctor. One light query, no paging.
    async _completedTotals(staffId) {
        const duties = await Duty.find({ assignedTo: staffId, status: 'completed' })
            .select('date endDate startTime endTime isOvernightDuty totalPayment paymentMethod isPaid')
            .lean();

        let hours = 0;
        let earnings = 0;
        let paid = 0;
        let pending = 0;
        for (const duty of duties) {
            const amount = duty.totalPayment || 0;
            hours += dutyHours(duty);
            earnings += amount;
            const status = paymentStatusOf(duty);
            if (status === 'paid') paid += amount;
            else if (status === 'pending') pending += amount;
        }

        const round = (n) => Math.round(n * 100) / 100;
        return { count: duties.length, hours, earnings: round(earnings), paid: round(paid), pending: round(pending) };
    },

    //Generate Statement
    async generateStatement(userId, filters, res) {
        const { dutyId, startDate, endDate } = filters;

        const staff = await MedicalStaff.findOne({ user: userId }).select('_id').lean();
        if (!staff) {
            throw new NotFoundError('Medical staff profile not found');
        }

        const populateStaffUser = { path: 'assignedTo', select: 'user', populate: { path: 'user', select: 'name email role' } };

        // ========= RECEIPT =========
        if (dutyId) {
            const duty = await Duty.findOne({ _id: dutyId, assignedTo: staff._id, status: 'completed' })
                .select(EARNINGS_DUTY_FIELDS)
                .populate('hospital', 'hospitalLegalName')
                .populate(populateStaffUser)
                .lean();
            if (!duty) throw new NotFoundError('Duty not found');

            const receiptData = {
                staff: {
                    name: duty.assignedTo?.user?.name || 'N/A',
                    email: duty.assignedTo?.user?.email || 'N/A',
                    role: duty.assignedTo?.user?.role || duty.staffRole || 'N/A'
                },
                dutyId: duty._id,
                hospital: duty.hospital?.hospitalLegalName || 'N/A',
                summary: {
                    role: duty.staffRole || 'N/A',
                    urgency: duty.urgency || 'Normal',
                    date: duty.completedAt || duty.date,
                    payment: duty.totalPayment || 0
                },
                totalEarning: duty.totalPayment || 0,
                rate: duty.offeredRate,
                time: {
                    startTime: duty.startTime,
                    endTime: duty.endTime,
                    duration: formatDuration(duty.startTime, duty.endTime, duty.date, duty.isOvernightDuty, duty.endDate)
                },
                payment: {
                    method: duty.paymentMethod || 'Unconfirmed',
                    status: duty.isPaid === true ? 'Paid' : duty.isPaid === false ? 'Will Pay Later' : 'Unconfirmed by hospital',
                    attestedAt: duty.paymentAttestedAt || null
                }
            };

            return generateDutyReceiptPDF(res, receiptData);
        }

        // ========= EARNINGS =========
        // Dates are IST days, both ends included. A duty counts on the day it was completed.
        const filter = { assignedTo: staff._id, status: 'completed' };
        if (startDate || endDate) {
            const range = {};
            if (startDate) range.$gte = istDayStart(startDate);
            if (endDate) range.$lt = istDayStart(addDaysToKey(endDate, 1));
            filter.$or = [{ completedAt: range }, { completedAt: null, date: range }];
        }

        const [duties, user] = await Promise.all([
            Duty.find(filter)
                .select(EARNINGS_DUTY_FIELDS)
                .populate('hospital', 'hospitalLegalName')
                .sort({ completedAt: -1, date: -1 })
                .lean(),
            User.findById(userId).select('name email role')
        ]);

        let totalEarnings = 0;
        let totalHours = 0;

        const data = duties.map(d => {
            totalEarnings += d.totalPayment || 0;
            totalHours += dutyHours(d);

            return {
                dutyDate: d.completedAt || d.date,
                hospital: d.hospital?.hospitalLegalName,
                role: d.staffRole,
                amount: d.totalPayment,
                rate: d.offeredRate,
                paymentStatus: paymentStatusOf(d),
                hours: formatDuration(
                    d.startTime,
                    d.endTime,
                    d.date,
                    d.isOvernightDuty,
                    d.endDate
                )
            };
        });

        let period = 'All Time';
        if (startDate && endDate) period = `${startDate} to ${endDate}`;
        else if (startDate) period = `From ${startDate}`;
        else if (endDate) period = `Up to ${endDate}`;

        const pdfData = {
            user,
            period,
            totalEarnings: Math.round(totalEarnings * 100) / 100,
            totalDuties: data.length,
            totalHours: formatDuration(totalHours),
            data
        };

        return generateEarningsPDF(res, pdfData);
    }
};
