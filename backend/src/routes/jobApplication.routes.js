const express = require('express');
const router = express.Router();
const jobApplicationController = require('../controllers/jobApplication.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { requireHospitalVerification } = require('../middleware/accountsVerification.middleware');
const {
    validateObjectId,
    validatePagination,
    validateJobApplicationStatusUpdate,
    validateJobApplicationWithdraw,
    validateJobApplicationListQuery,
    validateInterviewOfferSlots,
    validateInterviewSlotSelect,
    validateInterviewConfirm,
    validateInterviewMeetingLink,
    validateInterviewChangeReason,
    validateInterviewReschedule,
    validateInterviewOutcome,
    validateNoShowMark,
    validateNoShowDispute,
    validateOfferResponse
} = require('../middleware/validation.middleware');

router.use(protect);
router.use(checkSuspension);

// ─── Apply / review pipeline ────────────────────────────────────────────────

// Declared before '/vacancies/:id/...' single-segment routes in
// jobVacancy.routes.js purely as a defensive convention — these two-segment
// paths don't actually collide with '/vacancies/:id', but this router is
// still mounted first in app.js so that never becomes a live concern as
// routes are added later.
router.post(
    '/vacancies/:id/apply',
    authorize('staff'),
    validateObjectId('id'),
    jobApplicationController.apply
);

router.get(
    '/vacancies/:id/applications',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('id'),
    validatePagination,
    validateJobApplicationListQuery,
    jobApplicationController.listForVacancy
);

// Declared before '/applications/:applicationId' so it isn't swallowed by
// the wildcard param.
router.get(
    '/applications/mine',
    authorize('staff'),
    validatePagination,
    validateJobApplicationListQuery,
    jobApplicationController.listMine
);

router.get(
    '/applications/:applicationId',
    authorize('staff', 'hospital', 'admin'),
    validateObjectId('applicationId'),
    jobApplicationController.getById
);

router.get(
    '/applications/:applicationId/resume',
    authorize('staff', 'hospital', 'admin'),
    validateObjectId('applicationId'),
    jobApplicationController.getResume
);

router.patch(
    '/applications/:applicationId/status',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('applicationId'),
    validateJobApplicationStatusUpdate,
    jobApplicationController.updateStatus
);

router.patch(
    '/applications/:applicationId/withdraw',
    authorize('staff'),
    validateObjectId('applicationId'),
    validateJobApplicationWithdraw,
    jobApplicationController.withdraw
);

// ─── Interview scheduling ───────────────────────────────────────────────────

router.post(
    '/applications/:applicationId/interview/offer-slots',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('applicationId'),
    validateInterviewOfferSlots,
    jobApplicationController.offerSlots
);

router.patch(
    '/applications/:applicationId/slots/select',
    authorize('staff'),
    validateObjectId('applicationId'),
    validateInterviewSlotSelect,
    jobApplicationController.selectSlots
);

router.post(
    '/applications/:applicationId/interview/confirm',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('applicationId'),
    validateInterviewConfirm,
    jobApplicationController.confirmInterview
);

router.patch(
    '/applications/:applicationId/interview/cancel-offer',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('applicationId'),
    validateInterviewChangeReason,
    jobApplicationController.cancelOffer
);

router.patch(
    '/applications/:applicationId/interview/reschedule',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('applicationId'),
    validateInterviewReschedule,
    jobApplicationController.rescheduleInterview
);

// Shared staff/hospital route — one handler, requester.role picks the
// "other side" to notify. Reason list differs by role, checked inside
// validateInterviewChangeReason via req.user.role.
router.patch(
    '/applications/:applicationId/interview/cancel',
    authorize('staff', 'hospital'),
    validateObjectId('applicationId'),
    validateInterviewChangeReason,
    jobApplicationController.cancelInterview
);

router.patch(
    '/applications/:applicationId/interview/reschedule-request',
    authorize('staff'),
    validateObjectId('applicationId'),
    validateInterviewChangeReason,
    jobApplicationController.requestReschedule
);

router.patch(
    '/applications/:applicationId/interview/meeting-link',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('applicationId'),
    validateInterviewMeetingLink,
    jobApplicationController.updateMeetingLink
);

router.patch(
    '/applications/:applicationId/outcome',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('applicationId'),
    validateInterviewOutcome,
    jobApplicationController.recordOutcome
);

router.patch(
    '/applications/:applicationId/no-show/mark',
    authorize('hospital'),
    requireHospitalVerification,
    validateObjectId('applicationId'),
    validateNoShowMark,
    jobApplicationController.markNoShow
);

router.patch(
    '/applications/:applicationId/no-show/report',
    authorize('staff'),
    validateObjectId('applicationId'),
    jobApplicationController.reportNoShow
);

router.patch(
    '/applications/:applicationId/no-show/dispute',
    authorize('staff'),
    validateObjectId('applicationId'),
    validateNoShowDispute,
    jobApplicationController.disputeNoShow
);

router.patch(
    '/applications/:applicationId/offer/respond',
    authorize('staff'),
    validateObjectId('applicationId'),
    validateOfferResponse,
    jobApplicationController.respondToOffer
);

module.exports = router;
