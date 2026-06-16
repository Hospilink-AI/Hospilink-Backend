const express = require("express");
const router = express.Router();
const notificationController = require("../controllers/notification.controller");
const reviewController = require("../controllers/review.controller");
const { protect, authorize, checkSuspension } = require("../middleware/auth.middleware");
const { validateReviewSubmission, validateStaffIdParam } = require("../middleware/validation.middleware");

router.use(protect);
router.use(checkSuspension);
// Hospital submits review for staff
router.post(
    "/submit",
    authorize("hospital"),
    validateReviewSubmission,
    reviewController.submitReview
);

// Get staff reviews
router.get(
    "/staff/:staffId",
    validateStaffIdParam,
    reviewController.getStaffReviews
);

// Review Notification
router.put(
    "/:id/read",
    notificationController.markAsRead
);

module.exports = router;