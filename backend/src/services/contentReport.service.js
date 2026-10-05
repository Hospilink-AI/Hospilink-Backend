const Review = require('../models/Review');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const ticketService = require('./ticket.service');
const { NotFoundError, ValidationError, ForbiddenError } = require('../middleware/error.middleware');

const MAX_REASON = 1000;

// Reporting a review opens a rating-challenge ticket against its author, so
// support can hide it with the existing SUPPRESS_REVIEW action
class ContentReportService {
    async reportReview(user, reviewId, reason) {
        const text = typeof reason === 'string' ? reason.trim() : '';
        if (!text) throw new ValidationError('Please say what is wrong with this review.');
        if (text.length > MAX_REASON) throw new ValidationError(`Please keep it under ${MAX_REASON} characters.`);

        const review = await Review.findById(reviewId).select('duty reviewType hospital medicalStaff suppressed').lean();
        if (!review || review.suppressed) throw new NotFoundError('Review not found');

        const byHospital = review.reviewType === 'hospital_to_staff';
        const author = byHospital
            ? await Hospital.findById(review.hospital).select('user').lean()
            : await MedicalStaff.findById(review.medicalStaff).select('user').lean();
        if (!author?.user) throw new NotFoundError('Review not found');

        const reporterId = String(user._id || user.id);
        if (String(author.user) === reporterId) throw new ForbiddenError('You cannot report your own review.');

        const ticket = await ticketService.createTicket(user, {
            category: 'account.rating_challenge',
            subjectType: 'DUTY',
            subjectId: review.duty,
            raisedAgainst: { userId: author.user, role: byHospital ? 'hospital' : 'staff' },
            text: `Reported review ${review._id}: ${text}`
        });
        return { ticketId: ticket.ticketId, id: ticket._id };
    }
}

module.exports = new ContentReportService();
