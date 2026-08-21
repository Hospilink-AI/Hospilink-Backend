const JobApplication = require('../models/JobApplication');
const JobVacancy = require('../models/JobVacancy');
const Hospital = require('../models/Hospital');
const MedicalStaff = require('../models/MedicalStaff');
const Document = require('../models/Document');
const User = require('../models/User');
const vacancyMatchingService = require('./vacancyMatching.service');
const noShowPenaltyService = require('./noShowPenalty.service');
const notificationEmitter = require('./notificationEmitter');
const systemConfigService = require('./systemConfig.service');
const applicantVisibility = require('./applicantVisibility.service');
const resumeRedactionService = require('./resumeRedaction.service');
const cacheService = require('./cache.service');
const s3Service = require('./s3.service');
const { DOCX_MIME_TYPE } = require('../middleware/upload.middleware');

function inferMimeTypeFromKey(key) {
    const ext = (key.split('.').pop() || '').toLowerCase();
    const map = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', docx: DOCX_MIME_TYPE };
    return map[ext] || 'application/octet-stream';
}
const { hasCapability } = require('../config/adminPermissions.config');
const {
    NotFoundError, ForbiddenError, ConflictError, UnprocessableEntityError
} = require('../middleware/error.middleware');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const { ACTIVE_STATUSES } = require('../utils/jobApplication.constants');

// jobRole dimension only — 100 (exact role match) -> 'exact', 40 (same
// specialty family) -> 'related', anything else (including null, when either
// side has no jobRole at all) -> 'unscored'. This is the candidate-facing
// "gate tier" — never used to block an apply, only to sort/demote on the
// hospital's ranked list.
function deriveGateTier(matchBreakdown) {
    const jobRoleScore = matchBreakdown?.jobRole;
    if (jobRoleScore === 100) return 'exact';
    if (jobRoleScore === 40) return 'related';
    return 'unscored';
}

class JobApplicationService {
    // Staff applies to a live vacancy. Requires an existing MedicalStaff
    // profile AND a valid (non-rejected) resume-experience document already
    // on file — apply does not create a profile or parse a resume inline,
    // it reuses whichever onboarding path (manual or resume-reviewed) the
    // candidate already completed. Keeping profile/resume creation to exactly
    // one code path (profile.service.js) avoids two creation paths drifting
    // apart over time.
    async applyToVacancy(userId, vacancyId) {
        const vacancy = await JobVacancy.findById(vacancyId).lean();
        if (!vacancy || vacancy.deletedAt) {
            throw new NotFoundError('Vacancy not found');
        }

        const medicalStaff = await MedicalStaff.findOne({ user: userId });
        if (!medicalStaff) {
            await notificationEmitter.emitProfileRequiredForApplication(userId, vacancy);
            throw new UnprocessableEntityError(
                'Complete your profile before applying for a permanent job. You can apply using just your resume.'
            );
        }

        const resumeDoc = await this._findActiveResume(userId);
        if (!resumeDoc) {
            await notificationEmitter.emitResumeRequiredForApplication(userId, vacancy);
            const wasRejected = await this._hasRejectedResume(userId);
            throw new UnprocessableEntityError(
                wasRejected
                    ? 'Your uploaded resume was rejected. Please upload a new resume before applying.'
                    : 'Upload your resume to apply for permanent job openings.'
            );
        }

        const existingActive = await JobApplication.findOne({
            vacancy: vacancyId,
            staff: medicalStaff._id,
            status: { $in: ACTIVE_STATUSES }
        }).lean();
        if (existingActive) {
            throw new ConflictError('You already have an active application for this vacancy.');
        }

        const { matchScore, matchBreakdown } = vacancyMatchingService.computeMatchScore(medicalStaff, vacancy);
        // Applied after the weighted score, per §07 — "A multiplier of 0.95
        // per confirmed no-show inside the trailing 180 days, applied after
        // the weighted score." The frozen snapshot reflects whatever was in
        // effect at apply time, same as the gate tier.
        const penalizedScore = await noShowPenaltyService.applyMatchScoreMultiplier(medicalStaff._id, matchScore);

        const application = await JobApplication.create({
            vacancy: vacancyId,
            hospitalId: vacancy.hospitalId,
            staff: medicalStaff._id,
            user: userId,
            resumeDocumentId: resumeDoc._id,
            resumeS3Key: resumeDoc.s3Key,
            matchScoreSnapshot: {
                score: penalizedScore,
                breakdown: matchBreakdown,
                gateTier: deriveGateTier(matchBreakdown)
            },
            statusHistory: [{ status: 'applied', changedBy: userId, reason: 'Applied by staff' }]
        });

        await notificationEmitter.emitNewJobApplication(vacancy, application, medicalStaff.fullName);

        return application.toObject();
    }

    // Looks up the caller's active resume-experience document. Returns null
    // both when no resume was ever uploaded and when the only one on file
    // was rejected — callers that need to distinguish the two call
    // _hasRejectedResume separately for the error message only.
    async _findActiveResume(userId) {
        const docRecord = await Document.findOne({ userId }).lean();
        const resume = docRecord?.documents?.find(
            d => d.documentType === 'resume-experience' && !d.isDeleted
        );
        if (!resume || resume.verificationStatus === 'rejected') return null;
        return resume;
    }

    async _hasRejectedResume(userId) {
        const docRecord = await Document.findOne({ userId }).lean();
        const resume = docRecord?.documents?.find(
            d => d.documentType === 'resume-experience' && !d.isDeleted
        );
        return !!resume && resume.verificationStatus === 'rejected';
    }

    // Staff's own applications.
    async listMine(userId, filters, pagination) {
        const medicalStaff = await MedicalStaff.findOne({ user: userId }).select('_id').lean();
        if (!medicalStaff) {
            return { applications: [], pagination: getPaginationMeta(0, 1, pagination.limit || 10) };
        }

        const query = { staff: medicalStaff._id };
        if (filters.status) query.status = filters.status;

        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);

        const [applications, totalItems] = await Promise.all([
            JobApplication.find(query)
                .populate('vacancy', 'title specialty location')
                .populate('hospitalId', 'hospitalLegalName')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            JobApplication.countDocuments(query)
        ]);

        return { applications, pagination: getPaginationMeta(totalItems, page, limit) };
    }

    // Hospital's applications for one of its own vacancies — every entry is
    // projected through applicantVisibility's tier whitelist, never the raw
    // JobApplication/MedicalStaff documents.
    async listForVacancy(vacancyId, requester, filters, pagination) {
        const hospitalId = await this._resolveOwnedHospitalId(requester);

        const vacancy = await JobVacancy.findById(vacancyId).select('hospitalId deletedAt').lean();
        if (!vacancy) {
            throw new NotFoundError('Vacancy not found');
        }
        if (vacancy.hospitalId.toString() !== hospitalId.toString()) {
            throw new ForbiddenError("You don't have permission to do that.");
        }
        await this._assertVacancyAccessible(vacancy);

        const query = { vacancy: vacancyId };
        if (filters.status) query.status = filters.status;

        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);

        const [applications, totalItems] = await Promise.all([
            JobApplication.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            JobApplication.countDocuments(query)
        ]);

        const staffDocs = await MedicalStaff.find({ _id: { $in: applications.map(a => a.staff) } }).lean();
        const staffById = new Map(staffDocs.map(s => [s._id.toString(), s]));

        const views = applications.map(app => {
            const staff = staffById.get(app.staff.toString());
            return staff ? applicantVisibility.buildApplicantView(app, staff) : null;
        }).filter(Boolean);

        return { applications: views, pagination: getPaginationMeta(totalItems, page, limit) };
    }

    // 31-day post-close retention gate (§09's "Export and retention"):
    // applicant records stay reachable from the hospital surface for
    // postCloseApplicantRetentionDays after a vacancy closes, then become
    // hospital-inaccessible (still fully visible to admin/operations). A
    // live read-time check rather than a cron mutation — nothing needs to be
    // deleted or archived for this to hold.
    async _assertVacancyAccessible(vacancy) {
        if (!vacancy?.deletedAt) return;
        const retentionDays = await systemConfigService.getEffective('interview.postCloseApplicantRetentionDays');
        const cutoff = new Date(new Date(vacancy.deletedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000);
        if (new Date() > cutoff) {
            throw new NotFoundError('Applicant records for this vacancy are no longer accessible — it closed more than the retention window ago.');
        }
    }

    // Admin oversight — every application, every hospital, no ownership scoping.
    async listAllForAdmin(filters, pagination) {
        const query = {};
        if (filters.hospitalId) query.hospitalId = filters.hospitalId;
        if (filters.vacancyId) query.vacancy = filters.vacancyId;
        if (filters.status) query.status = filters.status;

        const { page, limit, skip } = getPaginationParams(pagination.page, pagination.limit);

        const [applications, totalItems] = await Promise.all([
            JobApplication.find(query)
                .populate('vacancy', 'title specialty')
                .populate('hospitalId', 'hospitalLegalName')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            JobApplication.countDocuments(query)
        ]);

        return { applications, pagination: getPaginationMeta(totalItems, page, limit) };
    }

    // Detail lookup shared by applicant/hospital/admin. The hospital branch
    // is projected through applicantVisibility's tier whitelist; the
    // applicant themself and admin see the full stored record.
    async getById(applicationId, requester) {
        const application = await JobApplication.findById(applicationId)
            .populate('vacancy')
            .populate('hospitalId', 'hospitalLegalName')
            .lean();
        if (!application) {
            throw new NotFoundError('Application not found');
        }

        await this._assertCanView(application, requester);

        if (requester.role === 'hospital') {
            await this._assertVacancyAccessible(application.vacancy);
            const medicalStaff = await MedicalStaff.findById(application.staff).lean();
            if (!medicalStaff) {
                throw new NotFoundError('Application not found');
            }
            return {
                ...applicantVisibility.buildApplicantView(application, medicalStaff),
                vacancy: application.vacancy,
                hospitalName: application.hospitalId?.hospitalLegalName
            };
        }

        return application;
    }

    // GET /applications/:id/resume — never returns a raw S3 URL to a
    // pre-hire hospital. Staff (the applicant) and admin always get the
    // original, unmasked file. A hospital gets a redacted, flattened
    // preview until the application reaches `hired` (Tier 3), and NEVER
    // falls back to the raw file if redaction isn't available for this
    // resume's format — that would defeat the entire control.
    async getResumeAccess(applicationId, requester) {
        const application = await JobApplication.findById(applicationId).lean();
        if (!application) {
            throw new NotFoundError('Application not found');
        }
        await this._assertCanView(application, requester);

        const isHospitalPreHire = requester.role === 'hospital' && application.status !== 'hired';
        if (!isHospitalPreHire) {
            const url = await s3Service.generatePreSignedURL(application.resumeS3Key);
            return { available: true, masked: false, url };
        }

        const cached = await cacheService.getRedactedResumeKey(application.resumeDocumentId);
        if (cached?.s3Key) {
            const url = await s3Service.generatePreSignedURL(cached.s3Key);
            return { available: true, masked: true, url };
        }

        const sourceBuffer = await s3Service.getObjectBuffer(application.resumeS3Key);
        const mimetype = inferMimeTypeFromKey(application.resumeS3Key);
        const result = await resumeRedactionService.redactResume(sourceBuffer, mimetype);

        if (!result.buffer) {
            // Never serve the raw original as a fallback — an unavailable
            // masked preview is a materially safer failure than a leaked one.
            return { available: false, masked: true, reason: result.reason };
        }

        const redactedKey = `resumes/redacted/${application.resumeDocumentId}.pdf`;
        await s3Service.uploadToS3(result.buffer, redactedKey, result.mimeType);
        await cacheService.setRedactedResumeKey(application.resumeDocumentId, redactedKey);

        const url = await s3Service.generatePreSignedURL(redactedKey);
        return { available: true, masked: true, url };
    }

    async _assertCanView(application, requester) {
        if (requester.role === 'admin') {
            if (!hasCapability(requester.adminSubRole, 'application.view')) {
                throw new ForbiddenError("You don't have permission to do that.");
            }
            return;
        }
        if (requester.role === 'staff') {
            if (application.user.toString() !== (requester.id || requester._id).toString()) {
                throw new ForbiddenError("You don't have permission to do that.");
            }
            return;
        }
        if (requester.role === 'hospital') {
            const hospitalId = await this._resolveOwnedHospitalId(requester);
            const applicationHospitalId = application.hospitalId?._id || application.hospitalId;
            if (applicationHospitalId.toString() !== hospitalId.toString()) {
                throw new ForbiddenError("You don't have permission to do that.");
            }
            return;
        }
        throw new ForbiddenError("You don't have permission to do that.");
    }

    async _resolveOwnedHospitalId(requester) {
        const hospital = await Hospital.findOne({ user: requester.id || requester._id }).select('_id').lean();
        if (!hospital) {
            throw new NotFoundError('Hospital profile not found.');
        }
        return hospital._id;
    }

    async _loadOwnedApplication(applicationId, requester) {
        const application = await JobApplication.findById(applicationId);
        if (!application) {
            throw new NotFoundError('Application not found');
        }
        const hospitalId = await this._resolveOwnedHospitalId(requester);
        if (application.hospitalId.toString() !== hospitalId.toString()) {
            throw new ForbiddenError("You don't have permission to do that.");
        }
        return application;
    }

    async _loadOwnApplicantApplication(applicationId, userId) {
        const application = await JobApplication.findById(applicationId);
        if (!application) {
            throw new NotFoundError('Application not found');
        }
        if (application.user.toString() !== userId.toString()) {
            throw new ForbiddenError("You don't have permission to do that.");
        }
        return application;
    }

    // Generic reviewer endpoint: applied->under_review->shortlisted->rejected,
    // plus offered->rejected (rescind). Interview-stage transitions
    // (shortlisted->slots_offered onward) are NOT reachable here — they go
    // through interviewScheduling.service.js's dedicated action methods,
    // whose payloads a generic status update can't express.
    async updateStatus(applicationId, requester, newStatus, reason, reasonText) {
        const application = await this._loadOwnedApplication(applicationId, requester);

        const check = application.canTransitionGeneric(newStatus);
        if (!check.allowed) {
            throw new UnprocessableEntityError(check.reason);
        }
        if (newStatus === 'rejected' && !reason) {
            throw new UnprocessableEntityError('A rejection reason is required.');
        }

        const actorId = requester.id || requester._id;
        application.status = newStatus;
        application.pushHistory(newStatus, actorId, reason);

        if (newStatus === 'under_review') {
            application.reviewedBy = actorId;
            application.reviewedAt = new Date();
        }
        if (newStatus === 'rejected') {
            application.rejectionReason = reason;
            application.rejectionReasonText = reasonText || null;
        }

        await application.save();

        if (newStatus === 'shortlisted') {
            await notificationEmitter.emitApplicationShortlisted(application);
        }
        if (newStatus === 'rejected') {
            await notificationEmitter.emitApplicationRejected(application, reason, reasonText);
        }

        return application.toObject();
    }

    async withdraw(applicationId, userId, reason, reasonText) {
        const application = await this._loadOwnApplicantApplication(applicationId, userId);

        const check = application.canWithdraw();
        if (!check.allowed) {
            throw new UnprocessableEntityError(check.reason);
        }
        if (!reason) {
            throw new UnprocessableEntityError('A withdrawal reason is required.');
        }

        application.status = 'withdrawn';
        application.withdrawnAt = new Date();
        application.withdrawReason = reason;
        application.withdrawReasonText = reasonText || null;
        application.pushHistory('withdrawn', userId, reason);

        await application.save();
        await notificationEmitter.emitApplicationWithdrawn(application);

        return application.toObject();
    }
}

module.exports = new JobApplicationService();
