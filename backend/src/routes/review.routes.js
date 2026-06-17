const express = require("express");
const router = express.Router();
const notificationController = require("../controllers/notification.controller");
const reviewController = require("../controllers/review.controller");
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { validateReviewSubmission, validateStaffIdParam } = require("../middleware/validation.middleware");

// Hospital submits review for staff
router.post(
    "/submit",
    protect,
    checkSuspension,
    authorize("hospital"),
    validateReviewSubmission,
    reviewController.submitReview
);

// Get staff reviews
router.get(
    "/staff/:staffId",
    protect,
    checkSuspension,
    validateStaffIdParam,
    reviewController.getStaffReviews
);

// Review Notification
router.put(
    "/:id/read",
    protect,
    notificationController.markAsRead
);

module.exports = router;