const Review = require("../models/Review");
const Duty = require("../models/Duty");
const Hospital = require("../models/Hospital");
const MedicalStaff = require("../models/MedicalStaff");
const notificationEmitter = require("./notificationEmitter");

class ReviewService {

    async submitReview(dutyId, userId, rating, reviewText) {

        // Validate rating range
        if (rating < 1 || rating > 5) {
            throw new Error("Rating must be between 1 and 5");
        }

        // Get hospital profile
        const hospital = await Hospital.findOne({ user: userId });

        if (!hospital) {
            throw new Error("Hospital profile not found");
        }

        const duty = await Duty.findById(dutyId).populate("assignedTo");

        if (!duty) {
            throw new Error("Duty not found");
        }

        // Ensure duty completed
        if (duty.status !== "completed") {
            throw new Error("Review allowed only after duty completion");
        }

        // Ensure hospital created duty
        if (duty.hospital.toString() !== hospital._id.toString()) {
            throw new Error("You can only review duties created by your hospital");
        }

        // Ensure duty has assigned staff
        if (!duty.assignedTo) {
            throw new Error("No medical staff assigned to this duty");
        }

        // Prevent duplicate review
        const existingReview = await Review.findOne({ duty: dutyId });

        if (existingReview) {
            throw new Error("Review already submitted for this duty");
        }

        // Create review
        // Create review
        const review = await Review.create({
            duty: dutyId,
            hospital: hospital._id,
            medicalStaff: duty.assignedTo,
            rating,
            review: reviewText
        });
        const populatedReview = await Review.findById(review._id)
            .populate("medicalStaff", "fullName jobRole")
            .populate("hospital", "hospitalLegalName");

        // Update staff rating
        const staff = await MedicalStaff.findById(duty.assignedTo);

        // Improvement added here
        if (!staff) {
            throw new Error("Medical staff not found");
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
}

module.exports = new ReviewService();