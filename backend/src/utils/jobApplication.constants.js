// Shared enums + transition rules for the JobApplication state machine.
// Kept out of models/JobApplication.js so services, controllers and
// validation middleware can import the same lists without pulling in
// Mongoose. See documents/JOB_APPLICATION_INTERVIEW_HIRING_PROCESS.pdf §02-03
// for the full reasoning behind every list here.

const STATUSES = [
    'applied', 'under_review', 'shortlisted', 'slots_offered', 'slot_selected',
    'confirmed', 'interviewed', 'offered', 'hired', 'rejected', 'withdrawn'
];

const TERMINAL_STATUSES = ['rejected', 'withdrawn', 'hired'];

// Statuses an application can still move through — the active-application
// partial-unique index (models/JobApplication.js) only blocks a second row
// while one of these holds, so a fresh apply always succeeds once the old
// row reaches a terminal status.
const ACTIVE_STATUSES = STATUSES.filter(s => !TERMINAL_STATUSES.includes(s));

// PATCH /applications/:id/status transitions only. offer-slots, select,
// confirm, reschedule, cancel, outcome and no-show each have their own
// dedicated service method with payload requirements a generic status
// update can't express — see the build spec §03's endpoint-mapping table.
const GENERIC_TRANSITIONS = {
    applied: ['under_review', 'rejected'],
    under_review: ['shortlisted', 'rejected'],
    shortlisted: ['rejected'],
    offered: ['rejected']
};

const REJECTION_REASONS = [
    'specialty_mismatch', 'insufficient_experience', 'skills_gap', 'location',
    'salary_expectation', 'qualification_or_registration', 'position_filled',
    'interview_outcome', 'did_not_attend_interview', 'other'
];

// Recruiter-side cancel-offer / cancel-interview / reschedule reasons.
const RECRUITER_CHANGE_REASONS = [
    'interviewer_unavailable', 'role_on_hold', 'role_filled',
    'candidate_no_longer_suitable', 'rescheduling', 'other'
];

// Candidate-side cancel-interview / reschedule-request reasons.
const CANDIDATE_CHANGE_REASONS = [
    'unavailable_at_that_time', 'unwell', 'accepted_another_role',
    'no_longer_interested', 'connectivity', 'other'
];

// Candidate withdraw reasons — CANDIDATE_CHANGE_REASONS plus one
// withdraw-specific option.
const WITHDRAW_REASONS = [
    'unavailable_at_that_time', 'unwell', 'accepted_another_role',
    'no_longer_interested', 'connectivity', 'found_a_different_role', 'other'
];

// True code constants (§14: "No — code constant") — never admin-editable.
// Everything else that governs slot mechanics (default duration, min/max
// slots per offer, scheduling window, reschedule cap, no-show grace, dispute
// window, outcome recording window) is admin-editable and versioned, so it
// lives in SystemConfig and is read at call time via systemConfig.service —
// never duplicated as a second hardcoded source of truth here.
const SLOT_DURATIONS = [15, 30, 45, 60];
const SLOT_GRANULARITY_MINUTES = 15;
const REASON_TEXT_MAX_LENGTH = 300;

module.exports = {
    STATUSES,
    TERMINAL_STATUSES,
    ACTIVE_STATUSES,
    GENERIC_TRANSITIONS,
    REJECTION_REASONS,
    RECRUITER_CHANGE_REASONS,
    CANDIDATE_CHANGE_REASONS,
    WITHDRAW_REASONS,
    SLOT_DURATIONS,
    SLOT_GRANULARITY_MINUTES,
    REASON_TEXT_MAX_LENGTH
};
