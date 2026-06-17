const Review = require("../models/Review");
const Duty = require("../models/Duty");
const Hospital = require("../models/Hospital");
const MedicalStaff = require("../models/MedicalStaff");
const notificationEmitter = require("./notificationEmitter");
const {
    ValidationError,
    NotFoundError,
    ConflictError,
    ForbiddenError
} = require('../middleware/error.middleware');

class ReviewService {

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

        // Emit real-time notification
        await notificationEmitter.emitReviewReceived(
            duty,
            hospital,
            staff,
            rating,
            reviewText
        );

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

        return populatedReview;
    }
}

module.exports = new ReviewService();
