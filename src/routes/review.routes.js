const express = require("express");
const router = express.Router();

const reviewController = require("../controllers/review.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Hospital submits review for staff
router.post(
    "/submit",
    protect,
    authorize("hospital"),
    reviewController.submitReview
);

// Get staff reviews
router.get(
    "/staff/:staffId",
    protect,
    reviewController.getStaffReviews
);

// Review Notification
router.put(
    "/:id/read",
    protect,
    require("../controllers/notification.controller").markAsRead
);

module.exports = router;