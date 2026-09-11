const jobApplicationService = require('../services/jobApplication.service');
const interviewSchedulingService = require('../services/interviewScheduling.service');
const { asyncHandler } = require('../middleware/error.middleware');

// ─── Apply / review pipeline ────────────────────────────────────────────────

// POST /api/vacancies/:id/apply — staff applies using the resume already on
// file. No file upload here — profile/resume creation stays the
// responsibility of profile.service.js / document.service.js, apply only
// checks that both already exist.
exports.apply = asyncHandler(async (req, res) => {
    const application = await jobApplicationService.applyToVacancy(req.user.id, req.params.id);
    res.status(201).json({
        success: true,
        application,
        message: 'Application submitted successfully'
    });
});

// GET /api/applications/mine — the caller's own applications.
exports.listMine = asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 10 } = req.query;
    const result = await jobApplicationService.listMine(
        req.user.id, { status }, { page: parseInt(page), limit: parseInt(limit) }
    );
    res.status(200).json({
        success: true,
        count: result.applications.length,
        data: result.applications,
        pagination: result.pagination
    });
});

// GET /api/vacancies/:id/applications — a hospital's applications for one of
// its own vacancies.
exports.listForVacancy = asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 10 } = req.query;
    const result = await jobApplicationService.listForVacancy(
        req.params.id, req.user, { status }, { page: parseInt(page), limit: parseInt(limit) }
    );
    res.status(200).json({
        success: true,
        count: result.applications.length,
        data: result.applications,
        pagination: result.pagination
    });
});

// GET /api/admin/vacancy-applications — cross-hospital oversight list.
exports.listAllForAdmin = asyncHandler(async (req, res) => {
    const { hospitalId, vacancyId, status, page = 1, limit = 10 } = req.query;
    const result = await jobApplicationService.listAllForAdmin(
        { hospitalId, vacancyId, status }, { page: parseInt(page), limit: parseInt(limit) }
    );
    res.status(200).json({
        success: true,
        count: result.applications.length,
        data: result.applications,
        pagination: result.pagination
    });
});

// GET /api/applications/:applicationId — detail, shared by applicant/hospital/admin.
exports.getById = asyncHandler(async (req, res) => {
    const application = await jobApplicationService.getById(req.params.applicationId, req.user);
    res.status(200).json({ success: true, application });
});

// GET /api/applications/:applicationId/resume — signed, short-lived URL.
// Masked/flattened for a hospital viewer pre-hire; original for the
// applicant, admin, or a hospital post-hire.
exports.getResume = asyncHandler(async (req, res) => {
    const access = await jobApplicationService.getResumeAccess(req.params.applicationId, req.user);
    if (!access.available) {
        return res.status(422).json({
            success: false,
            message: 'A masked preview is not available for this resume yet.',
            reason: access.reason
        });
    }
    res.status(200).json({ success: true, masked: access.masked, url: access.url });
});

// PATCH /api/applications/:applicationId/status — generic reviewer transitions.
exports.updateStatus = asyncHandler(async (req, res) => {
    const { status, reason, reasonText } = req.body;
    const application = await jobApplicationService.updateStatus(
        req.params.applicationId, req.user, status, reason, reasonText
    );
    res.status(200).json({ success: true, application, message: `Application moved to ${status}` });
});

// PATCH /api/applications/:applicationId/withdraw — candidate-only.
exports.withdraw = asyncHandler(async (req, res) => {
    const { reason, reasonText } = req.body;
    const application = await jobApplicationService.withdraw(req.params.applicationId, req.user.id, reason, reasonText);
    res.status(200).json({ success: true, application, message: 'Application withdrawn' });
});

// ─── Interview scheduling ───────────────────────────────────────────────────

// POST /api/applications/:applicationId/interview/offer-slots — hospital.
exports.offerSlots = asyncHandler(async (req, res) => {
    const { slots, durationMinutes } = req.body;
    const application = await interviewSchedulingService.offerSlots(req.params.applicationId, req.user, { slots, durationMinutes });
    res.status(200).json({ success: true, application, message: 'Interview slots offered' });
});

// PATCH /api/applications/:applicationId/slots/select — staff.
exports.selectSlots = asyncHandler(async (req, res) => {
    const application = await interviewSchedulingService.selectSlots(req.params.applicationId, req.user.id, req.body.picks);
    res.status(200).json({ success: true, application, message: 'Slots selected' });
});

// POST /api/applications/:applicationId/interview/confirm — hospital. The
// conditional-write endpoint: 200 on success, 409 with a structured
// slot-conflict payload if another application already took that slot.
exports.confirmInterview = asyncHandler(async (req, res) => {
    const { slotStart, slotEnd, meetingLink, interviewerName, interviewerDesignation } = req.body;
    const result = await interviewSchedulingService.confirmInterview(req.params.applicationId, req.user, {
        slotStart, slotEnd, meetingLink, interviewerName, interviewerDesignation
    });

    if (result.conflict) {
        return res.status(409).json({
            success: false,
            message: 'That slot was just confirmed for a different candidate.',
            blockedSlot: result.blockedSlot,
            remainingPicks: result.remainingPicks,
            needsReoffer: result.needsReoffer
        });
    }

    res.status(200).json({ success: true, application: result.application, message: 'Interview confirmed' });
});

// PATCH /api/applications/:applicationId/interview/cancel-offer — hospital.
exports.cancelOffer = asyncHandler(async (req, res) => {
    const { reason, reasonText } = req.body;
    const application = await interviewSchedulingService.cancelOffer(req.params.applicationId, req.user, reason, reasonText);
    res.status(200).json({ success: true, application, message: 'Interview offer cancelled' });
});

// PATCH /api/applications/:applicationId/interview/reschedule — hospital.
exports.rescheduleInterview = asyncHandler(async (req, res) => {
    const { slots, durationMinutes, reason, reasonText } = req.body;
    const application = await interviewSchedulingService.rescheduleInterview(
        req.params.applicationId, req.user, { slots, durationMinutes }, reason, reasonText
    );
    res.status(200).json({ success: true, application, message: 'Interview rescheduled' });
});

// PATCH /api/applications/:applicationId/interview/cancel — shared staff/hospital route.
exports.cancelInterview = asyncHandler(async (req, res) => {
    const { reason, reasonText } = req.body;
    const application = await interviewSchedulingService.cancelInterview(req.params.applicationId, req.user, reason, reasonText);
    res.status(200).json({ success: true, application, message: 'Interview cancelled' });
});

// PATCH /api/applications/:applicationId/interview/reschedule-request — staff.
exports.requestReschedule = asyncHandler(async (req, res) => {
    const { reason, reasonText } = req.body;
    const application = await interviewSchedulingService.requestReschedule(req.params.applicationId, req.user.id, reason, reasonText);
    res.status(200).json({ success: true, application, message: 'Reschedule requested' });
});

// PATCH /api/applications/:applicationId/interview/meeting-link — hospital.
exports.updateMeetingLink = asyncHandler(async (req, res) => {
    const { meetingLink, interviewerName, interviewerDesignation } = req.body;
    const application = await interviewSchedulingService.updateMeetingLink(req.params.applicationId, req.user, {
        meetingLink, interviewerName, interviewerDesignation
    });
    res.status(200).json({ success: true, application, message: 'Meeting link updated' });
});

// PATCH /api/applications/:applicationId/outcome — hospital.
exports.recordOutcome = asyncHandler(async (req, res) => {
    const { result, reason, reasonText } = req.body;
    const application = await interviewSchedulingService.recordOutcome(req.params.applicationId, req.user, { result, reason, reasonText });
    res.status(200).json({ success: true, application, message: `Outcome recorded: ${result}` });
});

// PATCH /api/applications/:applicationId/no-show/mark — hospital.
exports.markNoShow = asyncHandler(async (req, res) => {
    const { reoffer, newSlots, durationMinutes, reasonText } = req.body;
    const application = await interviewSchedulingService.markNoShow(req.params.applicationId, req.user, {
        reoffer, newSlots, durationMinutes, reasonText
    });
    res.status(200).json({ success: true, application, message: reoffer ? 'Fresh interview offer sent' : 'Candidate marked as no-show' });
});

// PATCH /api/applications/:applicationId/no-show/report — staff.
exports.reportNoShow = asyncHandler(async (req, res) => {
    const application = await interviewSchedulingService.reportNoShow(req.params.applicationId, req.user.id);
    res.status(200).json({ success: true, application, message: 'Reported — the hospital has been notified' });
});

// PATCH /api/applications/:applicationId/offer/respond — staff.
exports.respondToOffer = asyncHandler(async (req, res) => {
    const application = await interviewSchedulingService.respondToOffer(req.params.applicationId, req.user.id, req.body.accept);
    res.status(200).json({
        success: true,
        application,
        message: req.body.accept ? 'Offer accepted — you are hired!' : 'Offer declined'
    });
});
