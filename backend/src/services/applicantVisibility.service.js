const { SPECIALTY_FAMILIES } = require('../utils/constants');
const vacancyMatchingService = require('./vacancyMatching.service');

// The single whitelist entry point for hospital-facing applicant data. Every
// hospital-facing application read (jobApplication.service.js#getById /
// #listForVacancy) must go through buildApplicantView — never return a raw
// MedicalStaff document to a hospital. Fields not explicitly assembled here
// (photograph, marital status/religion/caste, government ID numbers, current
// salary, street address/PIN/geolocation, other applications, marketplace
// duty history/rates, no-show/dispute history, isSuspended, the raw
// resumeAnalysis blob) are structurally absent from the output, not filtered
// out after the fact — there is no blacklist to forget to update.
//
// The non-candidate blocks are `interview` (tier 2+): the hospital's own
// scheduling state for this application, see buildInterviewView; and, once an
// application has ended, the reason it did (rejectionReason / withdrawReason),
// see buildApplicantView.

const DIMENSION_LABELS = {
    jobRole: 'Specialty match',
    experience: 'Experience',
    skills: 'Skills',
    education: 'Education',
    location: 'Location'
};

function explainDimension(dimension, score) {
    const label = DIMENSION_LABELS[dimension] || dimension;
    if (score === null || score === undefined) return `${label}: not enough data to compare`;
    if (score >= 90) return `${label}: strong match (${score}%)`;
    if (score >= 60) return `${label}: good match (${score}%)`;
    if (score >= 30) return `${label}: partial match (${score}%)`;
    return `${label}: weak match (${score}%)`;
}

// Never a bare number — every dimension score ships with a short reason,
// per the candidate-visibility rule in §09/Match score.
function buildMatchBreakdownView(matchScoreSnapshot) {
    const breakdown = matchScoreSnapshot?.breakdown || {};
    return Object.entries(breakdown)
        .filter(([, score]) => score !== null && score !== undefined)
        .map(([dimension, score]) => ({
            dimension,
            label: DIMENSION_LABELS[dimension] || dimension,
            score,
            reason: explainDimension(dimension, score)
        }));
}

function deriveVerificationBadge(medicalStaff) {
    return medicalStaff.verificationStatus === 'verified' ? 'verified' : 'unverified';
}

function deriveRegistrationBadge(medicalStaff) {
    const extracted = medicalStaff.resumeAnalysis?.extractedData || {};
    const hasRegistration = !!extracted.hasRegistration || !!extracted.registrationNumber;
    return hasRegistration ? 'present' : 'absent';
}

// Tier 1 — visible the moment an application is created.
function buildTier1(application, medicalStaff) {
    const extracted = medicalStaff.resumeAnalysis?.extractedData || {};
    const family = SPECIALTY_FAMILIES[medicalStaff.jobRole] || null;

    return {
        fullName: medicalStaff.fullName,
        // Age only, never the date of birth itself. MedicalStaff has no DOB
        // field at all today — only ever available when the resume parser
        // extracted an age directly.
        age: typeof extracted.age === 'number' ? extracted.age : null,
        gender: extracted.gender || null,
        location: {
            city: medicalStaff.city || extracted.city || null,
            // No dedicated "district" field exists on MedicalStaff today —
            // falls back to the resume-extracted district when present,
            // otherwise omitted (never a street-level address).
            district: extracted.district || null
        },
        specialty: { role: medicalStaff.jobRole || null, family },
        totalExperienceYears: vacancyMatchingService.getCandidateExperienceYears(medicalStaff),
        // Structured employer/role/date history is only captured today via
        // resume parsing (resumeAnalysis.extractedData.experienceEntries) —
        // a manually-onboarded profile with no resume ever uploaded has none
        // yet. This is a MedicalStaff data-availability gap, not something
        // fabricated here.
        experienceEntries: extracted.experienceEntries || [],
        education: (medicalStaff.education && medicalStaff.education.length) ? medicalStaff.education : (extracted.education || []),
        skills: (medicalStaff.skills && medicalStaff.skills.length) ? medicalStaff.skills : (extracted.skills || []),
        currentEmployer: extracted.currentEmployer || null,
        expectedSalary: extracted.expectedSalary || null,
        verificationBadge: deriveVerificationBadge(medicalStaff),
        registrationBadge: deriveRegistrationBadge(medicalStaff),
        matchScore: application.matchScoreSnapshot?.score ?? null,
        matchBreakdown: buildMatchBreakdownView(application.matchScoreSnapshot),
        gateTier: application.matchScoreSnapshot?.gateTier || 'unscored',
        appliedAt: application.appliedAt || application.createdAt,
        resume: { available: true, masked: true }
    };
}

// Tier 2 — added on shortlist.
function buildTier2(medicalStaff) {
    return {
        registrationNumber: medicalStaff.resumeAnalysis?.extractedData?.registrationNumber || null,
        // MedicalStaff has no "reference details" field in the current
        // schema — there is nowhere for a candidate to supply references
        // yet. Exposed defensively as null so this serializer needs no
        // change once that field is added.
        referenceDetails: medicalStaff.referenceDetails || null
    };
}

// Tier 3 — released only once the candidate accepts the job offer.
function buildTier3(medicalStaff) {
    return {
        phone: medicalStaff.phoneNumber || null,
        email: medicalStaff.email || null,
        resume: { available: true, masked: false }
    };
}

// The offered times are only meaningful while an offer is live; picks only
// while there is something to act on (or the booking they led to).
const LIVE_OFFER_STATUSES = ['slots_offered', 'slot_selected'];
const PICKS_VISIBLE_STATUSES = ['slot_selected', 'confirmed'];

function toSlot(slot) {
    return { start: slot.start, end: slot.end };
}

// Interview scheduling state for the hospital — the offered times, the
// candidate's picks, and the booking (time, link, interviewer). Every field is
// assembled by hand, never spread from application.interview: that subdocument
// also holds no-show/dispute history, link/reschedule history and reminder
// bookkeeping, none of which a hospital may see.
//
// What is valid right now is derived here rather than trusted from storage:
//  - offer.slots survive cancelOffer and cron expiry (only cancelledAt is
//    set / the status changes), so the offer is shown only for a live status.
//  - Releasing a booking now clears its link, interviewer and reschedule
//    request at write time (interviewScheduling.service.js#_releaseBooking),
//    but records written before that still carry them. So the link and
//    interviewer are shown only while a booking exists (confirmedSlot set),
//    and a request only while confirmed and only if it was made after this
//    booking was confirmed — otherwise an old request would reappear on the
//    next booking. Kept as a safety net for those older records.
function buildInterviewView(application) {
    const interview = application.interview || {};
    const status = application.status;
    const offer = interview.offer;

    const hasLiveOffer = LIVE_OFFER_STATUSES.includes(status)
        && !offer?.cancelledAt
        && Array.isArray(offer?.slots)
        && offer.slots.length > 0;

    const confirmedSlot = interview.confirmedSlot?.start ? toSlot(interview.confirmedSlot) : null;
    const hasBooking = confirmedSlot !== null;

    const request = interview.rescheduleRequest;
    const hasCurrentRescheduleRequest = status === 'confirmed'
        && hasBooking
        && !!request?.pending
        && !!request.requestedAt
        && (!interview.confirmedAt || new Date(request.requestedAt) >= new Date(interview.confirmedAt));

    return {
        offer: hasLiveOffer
            ? {
                slots: offer.slots.map(toSlot),
                durationMinutes: offer.durationMinutes ?? null,
                // offer.expiresAt is the candidate's pick-by deadline. Once they
                // have picked (slot_selected) the confirm-by clock is a different,
                // live-computed one (interviewLifecycle.service.js), so echoing this
                // date there would show the hospital the wrong deadline.
                expiresAt: status === 'slots_offered' ? (offer.expiresAt ?? null) : null
            }
            : null,
        candidatePicks: PICKS_VISIBLE_STATUSES.includes(status)
            ? (interview.candidatePicks || []).map(toSlot)
            : [],
        confirmedSlot,
        meetingLink: hasBooking ? (interview.meetingLink ?? null) : null,
        interviewerName: hasBooking ? (interview.interviewerName ?? null) : null,
        interviewerDesignation: hasBooking ? (interview.interviewerDesignation ?? null) : null,
        rescheduleCount: interview.rescheduleCount || 0,
        rescheduleRequest: hasCurrentRescheduleRequest
            ? {
                pending: true,
                requestedAt: request.requestedAt,
                reason: request.reason ?? null,
                reasonText: request.reasonText ?? null
            }
            : null
    };
}

function tierForStatus(status) {
    if (status === 'hired') return 3;
    if (status === 'applied' || status === 'under_review') return 1;
    return 2; // shortlisted through every interview/outcome status
}

function buildApplicantView(application, medicalStaff) {
    const tier = tierForStatus(application.status);

    let view = {
        applicationId: application._id,
        status: application.status,
        tier,
        ...buildTier1(application, medicalStaff)
    };

    // Why the application ended, so the hospital can see why a candidate was
    // rejected or withdrew. Read off the already-loaded application (no extra
    // query) and gated on the current status, so only the pair matching how it
    // ended is shown. null, not omitted, if a terminal status was set without a
    // reason (e.g. an admin override). withdrawReasonText is free text typed by
    // the candidate; rejectionReasonText is the hospital's own.
    if (application.status === 'rejected') {
        view.rejectionReason = application.rejectionReason ?? null;
        view.rejectionReasonText = application.rejectionReasonText ?? null;
    } else if (application.status === 'withdrawn') {
        view.withdrawnAt = application.withdrawnAt ?? null;
        view.withdrawReason = application.withdrawReason ?? null;
        view.withdrawReasonText = application.withdrawReasonText ?? null;
    }

    if (tier >= 2) {
        view = {
            ...view,
            ...buildTier2(medicalStaff),
            // No extra query: `application` is already loaded by both callers
            // (getById / listForVacancy), interview is part of that document.
            interview: buildInterviewView(application)
        };
    }
    if (tier >= 3) view = { ...view, ...buildTier3(medicalStaff) };

    return view;
}

module.exports = { buildApplicantView, buildInterviewView, tierForStatus };
