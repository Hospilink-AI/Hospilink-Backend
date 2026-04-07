const ReviewService = require("../services/review.service");
const { asyncHandler } = require("../middleware/error.middleware");
const Review = require("../models/Review");
const Notification = require("../models/Notification");

//Submit Review (Hospital → Staff)
exports.submitReview = asyncHandler(async (req, res) => {

    const { duty_id, rating, review } = req.body;

    if (!duty_id || !rating) {
        return res.status(400).json({
            success: false,
            message: "duty_id and rating are required"
        });
    }

    // Validate rating
    if (rating < 1 || rating > 5) {
        return res.status(400).json({
            success: false,
            message: "Rating must be between 1 and 5"
        });
    }

    const result = await ReviewService.submitReview(
        duty_id,
        req.user.id,
        rating,
        review
    );

    res.status(201).json({
        success: true,
        message: "Review submitted successfully",
        data: {
            _id: result._id,
            duty: result.duty,
            rating: result.rating,
            review: result.review,
            createdAt: result.createdAt,
            // clean medical staff
            medicalStaff: {
                _id: result.medicalStaff._id,
                fullName: result.medicalStaff.fullName,
                jobRole: result.medicalStaff.jobRole
            },
            hospital: {
                _id: result.hospital._id,
                hospitalLegalName: result.hospital.hospitalLegalName
            },
            message: result.review
                ? `You received a ${result.rating}⭐ review: "${result.review}"`
                : `You received a ${result.rating}⭐ rating from hospital`
        }
    });

});

// Get Reviews for Staff

exports.getStaffReviews = asyncHandler(async (req, res) => {

    const { staffId } = req.params;

    const reviews = await Review.find({ medicalStaff: staffId })
        .populate("hospital", "hospitalLegalName")
        .populate("duty", "date startTime endTime")
        .select("rating review duty hospital createdAt")
        .sort({ createdAt: -1 });
    const formattedReviews = reviews.map(r => {
        const obj = r.toObject();
        return {
            _id: obj._id,
            rating: obj.rating,
            review: obj.review,
            createdAt: obj.createdAt,
            hospital: obj.hospital,
            ...(obj.duty && { duty: obj.duty })
        };
    });
    res.status(200).json({
        success: true,
        count: formattedReviews.length,
        reviews: formattedReviews
    });

});

exports.markAsRead = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const notification = await Notification.findById(id);
    if (!notification) {
        return res.status(404).json({
            success: false,
            message: "Notification not found"
        });
    }
    // Ensure user owns this notification
    if (notification.recipient.toString() !== req.user.id) {
        return res.status(403).json({
            success: false,
            message: "Unauthorized"
        });
    }
    notification.isRead = true;
    await notification.save();
    res.status(200).json({
        success: true,
        message: "Notification marked as read"
    });
});