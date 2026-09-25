const Review = require("../models/Review");
const Duty = require("../models/Duty");
const Hospital = require("../models/Hospital");
const MedicalStaff = require("../models/MedicalStaff");
const notificationEmitter = require("./notificationEmitter");
const systemConfigService = require("./systemConfig.service");
const cacheService = require("./cache.service");
const {
    ValidationError,
    NotFoundError,
    ConflictError,
    ForbiddenError
} = require('../middleware/error.middleware');

// Blind/simultaneous reveal (Phase 3) — a review is visible to its own
// author always; to anyone else, only once the sibling review for the same
// duty also exists, or the configured timeout has passed. No in-between
// per-viewer state, so there's no indirect leak path via a third party.
function isRevealed(review, sibling, timeoutMs) {
    if (!review) return false;
    if (sibling) return true;
    return (Date.now() - review.createdAt.getTime()) >= timeoutMs;
}

function shapeReview(review) {
    if (!review) return null;
    return { rating: review.rating, review: review.review, reviewedAt: review.createdAt };
}

class ReviewService {
    // The one place Review is ever queried by duty id — every per-duty
    // read routes through this (or its batched sibling below) so "which
    // review is which" is never ambiguous again.
    async getReviewPairForDuty(dutyId) {
        const reviews = await Review.find({ duty: dutyId, suppressed: { $ne: true } }).select('rating review createdAt reviewType');
        return {
            hospitalToStaff: reviews.find(r => r.reviewType === 'hospital_to_staff') || null,
            staffToHospital: reviews.find(r => r.reviewType === 'staff_to_hospital') || null
        };
    }

    // Batched — one query for many duties, not one per duty. Returns
    // Map<dutyIdString, { hospitalToStaff, staffToHospital }>.
    async getReviewPairsForDuties(dutyIds) {
        const byDuty = new Map(dutyIds.map(id => [id.toString(), { hospitalToStaff: null, staffToHospital: null }]));
        if (dutyIds.length === 0) return byDuty;

        const reviews = await Review.find({ duty: { $in: dutyIds }, suppressed: { $ne: true } }).select('duty rating review createdAt reviewType');
        for (const r of reviews) {
            const pair = byDuty.get(r.duty.toString());
            if (!pair) continue;
            if (r.reviewType === 'hospital_to_staff') pair.hospitalToStaff = r;
            else pair.staffToHospital = r;
        }
        return byDuty;
    }

    // viewerRole: 'staff' | 'hospital' | 'admin' — their relation to THIS
    // duty specifically. 'staff' always sees their own staffToHospital
    // review; 'hospital' always sees their own hospitalToStaff review;
    // 'admin' sees both unconditionally; anyone else is treated as neither
    // author, gated by the reveal rule alone.
    _shapePair(hospitalToStaff, staffToHospital, viewerRole, timeoutMs) {
        const admin = viewerRole === 'admin';
        const hospitalToStaffVisible = admin || viewerRole === 'hospital' || isRevealed(hospitalToStaff, staffToHospital, timeoutMs);
        const staffToHospitalVisible = admin || viewerRole === 'staff' || isRevealed(staffToHospital, hospitalToStaff, timeoutMs);

        return {
            hospitalToStaff: hospitalToStaffVisible ? shapeReview(hospitalToStaff) : null,
            staffToHospital: staffToHospitalVisible ? shapeReview(staffToHospital) : null
        };
    }

    async getVisibleReviewsForDuty(dutyId, viewerRole) {
        const timeoutDays = await systemConfigService.getEffective('rating.blindRevealTimeoutDays');
        const { hospitalToStaff, staffToHospital } = await this.getReviewPairForDuty(dutyId);
        return this._shapePair(hospitalToStaff, staffToHospital, viewerRole, timeoutDays * 24 * 60 * 60 * 1000);
    }

    // Returns Map<dutyIdString, { hospitalToStaff, staffToHospital }> —
    // same shape as getReviewPairsForDuties, but each side already shaped
    // for viewerRole per the reveal rule.
    async getVisibleReviewPairsForDuties(dutyIds, viewerRole) {
        const timeoutDays = await systemConfigService.getEffective('rating.blindRevealTimeoutDays');
        const timeoutMs = timeoutDays * 24 * 60 * 60 * 1000;
        const pairs = await this.getReviewPairsForDuties(dutyIds);

        const shaped = new Map();
        for (const [dutyId, { hospitalToStaff, staffToHospital }] of pairs) {
            shaped.set(dutyId, this._shapePair(hospitalToStaff, staffToHospital, viewerRole, timeoutMs));
        }
        return shaped;
    }

    async submitReview(dutyId, userId, userRole, rating, reviewText) {

        // Validate rating range
        if (rating < 1 || rating > 5) {
            throw new ValidationError("Rating must be between 1 and 5");
        }

        const duty = await Duty.findById(dutyId).populate("assignedTo");

        if (!duty) {
            throw new NotFoundError("Duty not found");
        }

        // Ensure duty completed
        if (duty.status !== "completed") {
            throw new ValidationError("Review allowed only after duty completion");
        }

        if (userRole === "hospital") {
            return this.submitHospitalToStaffReview(duty, userId, rating, reviewText);
        }

        if (userRole === "staff") {
            return this.submitStaffToHospitalReview(duty, userId, rating, reviewText);
        }

        throw new ForbiddenError("Only hospitals or staff can submit reviews");
    }



    // Hospital rates the medical staff assigned to a completed duty
    async submitHospitalToStaffReview(duty, userId, rating, reviewText) {
        const hospital = await Hospital.findOne({ user: userId });

        if (!hospital) {
            throw new NotFoundError("Hospital profile not found");
        }

        // Ensure hospital created duty
        if (duty.hospital.toString() !== hospital._id.toString()) {
            throw new ForbiddenError("You can only review duties created by your hospital");
        }

        // Ensure duty has assigned staff
        if (!duty.assignedTo) {
            throw new ValidationError("No medical staff assigned to this duty");
        }

        // Prevent duplicate review
        const existingReview = await Review.findOne({ duty: duty._id, reviewType: "hospital_to_staff" });

        if (existingReview) {
            throw new ConflictError("Review already submitted for this duty");
        }

        const review = await Review.create({
            duty: duty._id,
            reviewType: "hospital_to_staff",
            hospital: hospital._id,
            medicalStaff: duty.assignedTo._id,
            rating,
            review: reviewText
        });

        const populatedReview = await Review.findById(review._id)
            .populate("medicalStaff", "fullName jobRole")
            .populate("hospital", "hospitalLegalName");

        // Update staff rating
        const staff = await MedicalStaff.findById(duty.assignedTo._id);

        if (!staff) {
            throw new NotFoundError("Medical staff not found");
        }

        const newTotal = staff.totalRatings + 1;

        const newAverage =
            ((staff.averageRating * staff.totalRatings) + rating) / newTotal;

        staff.totalRatings = newTotal;
        staff.averageRating = Number(newAverage.toFixed(2));

        await staff.save();

        // GET /api/profile/me caches its whole response for 15 minutes —
        // without this, a staff member could keep seeing their pre-review
        // rating for up to that long after receiving one.
        await cacheService.invalidateUserProfiles(staff.user.toString());

        // Emit real-time notification (content-free — see
        // notificationEmitter.js#emitReviewReceived's own comment)
        await notificationEmitter.emitReviewReceived(duty, hospital, staff);

        return populatedReview;
    }



    // Staff rates the hospital that hosted a completed duty
    async submitStaffToHospitalReview(duty, userId, rating, reviewText) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId });

        if (!medicalStaff) {
            throw new NotFoundError("Medical staff profile not found");
        }

        // Ensure duty was assigned to this staff member
        if (!duty.assignedTo || duty.assignedTo._id.toString() !== medicalStaff._id.toString()) {
            throw new ForbiddenError("You can only review duties assigned to you");
        }

        // Prevent duplicate review
        const existingReview = await Review.findOne({ duty: duty._id, reviewType: "staff_to_hospital" });

        if (existingReview) {
            throw new ConflictError("Review already submitted for this duty");
        }

        const review = await Review.create({
            duty: duty._id,
            reviewType: "staff_to_hospital",
            hospital: duty.hospital,
            medicalStaff: medicalStaff._id,
            rating,
            review: reviewText
        });

        const populatedReview = await Review.findById(review._id)
            .populate("medicalStaff", "fullName jobRole")
            .populate("hospital", "hospitalLegalName");

        // Update hospital rating
        const hospital = await Hospital.findById(duty.hospital);

        if (!hospital) {
            throw new NotFoundError("Hospital not found");
        }

        const newTotal = hospital.totalRatings + 1;

        const newAverage =
            ((hospital.averageRating * hospital.totalRatings) + rating) / newTotal;

        hospital.totalRatings = newTotal;
        hospital.averageRating = Number(newAverage.toFixed(2));

        await hospital.save();

        // Same staleness fix as the hospital-to-staff direction above.
        await cacheService.invalidateUserProfiles(hospital.user.toString());

        // Emit real-time notification (content-free — see
        // notificationEmitter.js#emitHospitalReviewReceived's own comment)
        await notificationEmitter.emitHospitalReviewReceived(duty, medicalStaff, hospital);

        return populatedReview;
    }
}

module.exports = new ReviewService();
