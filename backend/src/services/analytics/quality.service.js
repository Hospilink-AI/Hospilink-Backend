const Review = require('../../models/Review');
const Ticket = require('../../models/Ticket');
const PatternFlag = require('../../models/PatternFlag');
const Hospital = require('../../models/Hospital');
const MedicalStaff = require('../../models/MedicalStaff');
const { loadDuties, splitByPeriod } = require('./dutyData');
const { tile, ratio, round, sum, countBy, seriesFromRows } = require('../../utils/analytics.helper');

const STAFF_REVIEW = 'hospital_to_staff';
const HOSPITAL_REVIEW = 'staff_to_hospital';
const COMPLAINT_DOMAINS = ['duty', 'payment'];

const average = (values) => (values.length ? round(sum(values) / values.length, 2) : null);

class QualityAnalytics {
    async build(period, filters) {
        const range = { $gte: period.compareStart, $lt: period.end };

        const [completed, reviews, complaints, penaltyTickets, flags, staffSuspended, hospitalsSuspended] = await Promise.all([
            loadDuties('completedAt', period.compareStart, period.end, filters, 'completedAt', { status: 'completed' }),
            Review.find({ createdAt: range }).select('duty reviewType rating suppressed createdAt').lean(),
            Ticket.find({ createdAt: range, resolutionClass: 'ADJUDICATED', domain: { $in: COMPLAINT_DOMAINS } })
                .select('createdAt category raisedAgainst.role resolutionOutcome').lean(),
            Ticket.find({ 'resolutionActions.action': { $in: ['APPLY_RATING_PENALTY', 'REVERSE_RATING_PENALTY'] } })
                .select('resolutionActions.action resolutionActions.executedAt').lean(),
            PatternFlag.find({ createdAt: range }).select('createdAt partyRole raises status proposal.decision').lean(),
            MedicalStaff.find({ isSuspended: true, suspendedAt: range }).select('suspendedAt').lean(),
            Hospital.find({ isSuspended: true, suspendedAt: range }).select('suspendedAt').lean()
        ]);

        const completedSplit = splitByPeriod(completed, d => d.completedAt, period);
        const reviewSplit = splitByPeriod(reviews, r => r.createdAt, period);
        const complaintSplit = splitByPeriod(complaints, t => t.createdAt, period);
        const flagSplit = splitByPeriod(flags, f => f.createdAt, period);
        const suspensionSplit = splitByPeriod([...staffSuspended, ...hospitalsSuspended], s => s.suspendedAt, period);

        const penaltyActions = penaltyTickets.flatMap(t => t.resolutionActions || [])
            .filter(a => ['APPLY_RATING_PENALTY', 'REVERSE_RATING_PENALTY'].includes(a.action) && a.executedAt);
        const penaltySplit = splitByPeriod(penaltyActions, a => a.executedAt, period);

        // Reviews left for the duties completed in each period
        const reviewsByDuty = await this._reviewsForDuties([...completedSplit.current, ...completedSplit.previous]);

        const measure = (completedRows, reviewRows, complaintRows, flagRows, suspensionRows, penaltyRows) => {
            const visible = reviewRows.filter(r => !r.suppressed);
            const reviewed = (type) => completedRows.filter(d => reviewsByDuty.get(d._id.toString())?.has(type)).length;
            return {
                staffRating: average(visible.filter(r => r.reviewType === STAFF_REVIEW).map(r => r.rating)),
                hospitalRating: average(visible.filter(r => r.reviewType === HOSPITAL_REVIEW).map(r => r.rating)),
                staffReviewCompletion: ratio(reviewed(STAFF_REVIEW), completedRows.length),
                hospitalReviewCompletion: ratio(reviewed(HOSPITAL_REVIEW), completedRows.length),
                suppressedReviews: reviewRows.filter(r => r.suppressed).length,
                complaintsPer100: completedRows.length ? round((complaintRows.length / completedRows.length) * 100, 2) : null,
                penaltiesApplied: penaltyRows.filter(a => a.action === 'APPLY_RATING_PENALTY').length,
                penaltiesReversed: penaltyRows.filter(a => a.action === 'REVERSE_RATING_PENALTY').length,
                patternFlags: flagRows.length,
                suspensions: suspensionRows.length
            };
        };

        const cur = measure(completedSplit.current, reviewSplit.current, complaintSplit.current, flagSplit.current, suspensionSplit.current, penaltySplit.current);
        const prev = measure(completedSplit.previous, reviewSplit.previous, complaintSplit.previous, flagSplit.previous, suspensionSplit.previous, penaltySplit.previous);

        const tiles = [
            tile('staffRating', 'Average rating hospitals gave staff', cur.staffRating, prev.staffRating, 'rating'),
            tile('hospitalRating', 'Average rating staff gave hospitals', cur.hospitalRating, prev.hospitalRating, 'rating'),
            tile('staffReviewCompletion', 'Completed duties rated by the hospital', cur.staffReviewCompletion, prev.staffReviewCompletion, 'ratio'),
            tile('hospitalReviewCompletion', 'Completed duties rated by the staff member', cur.hospitalReviewCompletion, prev.hospitalReviewCompletion, 'ratio'),
            tile('complaintsPer100', 'Complaints per 100 completed duties', cur.complaintsPer100, prev.complaintsPer100, 'ratio'),
            tile('penaltiesApplied', 'Rating penalties applied', cur.penaltiesApplied, prev.penaltiesApplied, 'count'),
            tile('penaltiesReversed', 'Rating penalties reversed', cur.penaltiesReversed, prev.penaltiesReversed, 'count'),
            tile('suppressedReviews', 'Reviews suppressed', cur.suppressedReviews, prev.suppressedReviews, 'count'),
            tile('patternFlags', 'Pattern flags raised', cur.patternFlags, prev.patternFlags, 'count'),
            tile('suspensions', 'Accounts suspended', cur.suspensions, prev.suspensions, 'count')
        ];

        const reviewsNow = reviewSplit.current.filter(r => !r.suppressed);

        const charts = [
            {
                key: 'ratingTrend',
                type: 'line',
                title: 'Reviews left',
                series: seriesFromRows(reviewsNow, r => r.createdAt, period, {
                    staffReviews: r => (r.reviewType === STAFF_REVIEW ? 1 : 0),
                    hospitalReviews: r => (r.reviewType === HOSPITAL_REVIEW ? 1 : 0)
                })
            },
            { key: 'staffRatingDistribution', type: 'bar', title: 'Stars hospitals gave staff', rows: this._stars(reviewsNow, STAFF_REVIEW) },
            { key: 'hospitalRatingDistribution', type: 'bar', title: 'Stars staff gave hospitals', rows: this._stars(reviewsNow, HOSPITAL_REVIEW) },
            {
                key: 'complaintsAgainst',
                type: 'donut',
                title: 'Who complaints were about',
                rows: countBy(complaintSplit.current, t => t.raisedAgainst?.role || 'unknown')
            },
            { key: 'complaintCategories', type: 'table', title: 'Complaint categories', rows: countBy(complaintSplit.current, t => t.category) },
            { key: 'complaintOutcomes', type: 'donut', title: 'How complaints ended', rows: countBy(complaintSplit.current, t => t.resolutionOutcome || 'open') },
            {
                key: 'patternFlags',
                type: 'table',
                title: 'Pattern flags by type and result',
                rows: countBy(flagSplit.current, f => `${f.partyRole}:${f.raises}:${f.proposal?.decision || f.status}`)
                    .map(({ key, count }) => {
                        const [partyRole, raises, result] = key.split(':');
                        return { partyRole, raises, result, count };
                    })
            }
        ];

        return {
            tiles,
            charts,
            dataNotes: [
                'Averages leave out suppressed reviews.',
                'Suspensions count accounts suspended in the period that are still suspended.',
                'Staff and hospital watchlists are on the Auto-Relist page.'
            ]
        };
    }



    async _reviewsForDuties(duties) {
        if (!duties.length) return new Map();
        const rows = await Review.find({ duty: { $in: duties.map(d => d._id) } }).select('duty reviewType').lean();
        const byDuty = new Map();
        for (const r of rows) {
            const id = r.duty.toString();
            if (!byDuty.has(id)) byDuty.set(id, new Set());
            byDuty.get(id).add(r.reviewType);
        }
        return byDuty;
    }



    _stars(reviews, type) {
        return [1, 2, 3, 4, 5].map(stars => ({
            stars,
            count: reviews.filter(r => r.reviewType === type && Math.round(r.rating) === stars).length
        }));
    }
}

module.exports = new QualityAnalytics();
