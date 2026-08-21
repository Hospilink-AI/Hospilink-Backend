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

    if (tier >= 2) view = { ...view, ...buildTier2(medicalStaff) };
    if (tier >= 3) view = { ...view, ...buildTier3(medicalStaff) };

    return view;
}

module.exports = { buildApplicantView, tierForStatus };
