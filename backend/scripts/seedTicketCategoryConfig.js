// One-time seed: writes the §03 taxonomy table (51 categories, their
// resolutionClass, route, and evidence guidance) into SystemConfig via
// ticketCategoryConfig.service, so Ticket.js's pre-validate hook has
// something to read, and the chatbot's evidence-ask step (Phase 2) has
// something to say beyond a generic prompt.
// Safe to re-run — each run just inserts a new effectiveFrom version, same
// as any other SystemConfig write; it never edits a row in place.
//
// Usage: node scripts/seedTicketCategoryConfig.js
// __dirname here is backend/scripts — the repo's .env lives two levels up
// (repo root), same as server.js resolves it from backend/ (one level up).
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const connectDB = require('../src/config/database');
const ticketCategoryConfigService = require('../src/services/ticketCategoryConfig.service');

// [category, resolutionClass, queue, evidenceRequired] — resolutionClass/
// queue transcribed from the spec's §03 taxonomy tables; evidenceRequired
// is hand-written (Phase 2 of the chatbot intake work) — a short, concrete
// list of what a real user would actually have, not generic filler. An
// empty list is a deliberate choice for categories that are requests/
// housekeeping rather than disputes needing supporting proof (most
// statutory data.* requests, withdrawal/cancellation requests, feedback).
const TABLE = [
    // duty — platform-worker regime
    ['duty.end_otp_unverified', 'ACTIONED', 'SUPPORT', ["Screenshot showing the shift wasn't ended", 'Any messages with the hospital about it']],
    ['duty.start_otp_failure', 'ACTIONED', 'SUPPORT', ['Screenshot of the OTP error/failure', 'Time you attempted to start the shift']],
    ['duty.no_show_staff', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the shift confirmation', 'Any messages about the absence']],
    ['duty.no_show_hospital', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the shift confirmation', 'Photo/proof you were on-site', 'Any messages with the hospital']],
    ['duty.late_arrival', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the scheduled start time', 'Any messages explaining the delay']],
    ['duty.early_departure', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the scheduled end time', 'Reason/message about leaving early']],
    ['duty.cancellation_staff', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the cancellation', 'Reason for the cancellation']],
    ['duty.cancellation_hospital', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the cancellation notice', 'How much notice you were given']],
    ['duty.details_mismatch', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the original posted/agreed details', 'Photo or note of what you actually found on arrival']],
    ['duty.status_change_request', 'ACTIONED', 'SUPPORT', ["Screenshot of the shift's current recorded status", 'Evidence of the correct status (e.g. completion proof)']],
    ['duty.details_change_request', 'ACTIONED', 'SUPPORT', ['Screenshot of the current recorded details', 'What the correct details should be']],
    ['duty.work_quality', 'ADJUDICATED', 'OPERATIONS', ['Specific description of the quality issue', 'Any supporting photos/documentation']],
    ['duty.working_conditions', 'ADJUDICATED', 'OPERATIONS', ['Photos of the conditions', 'Any messages raising the concern at the time']],
    ['duty.scope_of_practice', 'ADJUDICATED', 'SUPER_ADMIN', ['What you were asked to do', 'Your role/qualification documentation']],
    ['duty.conduct_staff', 'ADJUDICATED', 'OPERATIONS', ['Description of what happened, with date/time', 'Any messages or witnesses']],
    ['duty.conduct_hospital', 'ADJUDICATED', 'SUPER_ADMIN', ['Description of what happened, with date/time', 'Any messages or witnesses']],
    ['duty.credential_challenge', 'ADJUDICATED', 'OPERATIONS', ['The credential/certificate in question', "Reason you believe it's being challenged incorrectly"]],

    // payment — platform-worker regime, consequence actions gated
    ['payment.non_payment', 'ADJUDICATED', 'OPERATIONS', ['Payment/receipt screenshot (if any)', 'Bank or UPI statement showing no payment received']],
    ['payment.amount_mismatch', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the agreed rate/amount', 'Screenshot of what was actually paid']],
    ['payment.overtime_unpaid', 'ADJUDICATED', 'OPERATIONS', ['Proof of the extra time worked (shift end time vs. actual)', 'Screenshot of payment received (showing overtime missing)']],
    ['payment.deduction_disputed', 'ADJUDICATED', 'OPERATIONS', ['Payment screenshot showing the deduction', 'Reason you believe the deduction is wrong']],
    ['payment.mode_dispute', 'ADJUDICATED', 'SUPPORT', ['Screenshot of the agreed payment mode', 'Screenshot of how payment was actually made/attempted']],
    ['payment.refund_request', 'ADJUDICATED', 'SUPER_ADMIN', ['Original payment/receipt screenshot', 'Reason a refund is due']],

    // safety — platform-worker regime, every case P1
    ['safety.patient_incident', 'ADJUDICATED', 'SUPER_ADMIN', ['Description of the incident, with date/time', 'Any photos, reports, or witnesses']],
    ['safety.staff_incident', 'ADJUDICATED', 'SUPER_ADMIN', ['Description of the incident, with date/time', 'Photos of any injury/unsafe condition', 'Any witnesses']],
    ['safety.harassment', 'ADJUDICATED', 'SUPER_ADMIN', ['Screenshots or recordings of the incident, if you have them', 'Names of anyone who witnessed it']],

    // jobs — intermediary regime
    ['jobs.application_revoke', 'ACTIONED', 'SUPPORT', []],
    ['jobs.interview_reschedule', 'ACTIONED', 'SUPPORT', []],
    ['jobs.interview_cancellation', 'ACTIONED', 'SUPPORT', []],
    ['jobs.interview_no_show', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the confirmed interview time', 'Any messages about the no-show']],
    ['jobs.ai_score_challenge', 'INVESTIGATED', 'OPERATIONS', ["Screenshot of the score you're disputing", 'What you believe is inaccurate about it']],
    ['jobs.parsed_data_incorrect', 'ACTIONED', 'SUPPORT', ['Screenshot of the incorrect field(s)', 'The correct information']],
    ['jobs.listing_misleading', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the original listing', "What you found didn't match"]],
    ['jobs.offer_reneged', 'ADJUDICATED', 'SUPER_ADMIN', ['Screenshot of the offer', 'Any messages about it being withdrawn']],

    // account — intermediary regime
    ['account.verification_delay', 'ACTIONED', 'SUPPORT', []],
    ['account.verification_rejected', 'ADJUDICATED', 'OPERATIONS', ['The rejection notice/message you received', 'The document that was rejected']],
    ['account.rating_challenge', 'ADJUDICATED', 'OPERATIONS', ['Screenshot of the rating/review in question', "Reason you believe it's unfair or inaccurate"]],
    ['account.suspension_appeal', 'ADJUDICATED', 'SUPER_ADMIN', ['The suspension notice you received', 'Your explanation/evidence for the appeal']],
    ['account.access_locked', 'ACTIONED', 'SUPPORT', ["Screenshot of the error you're seeing, if any"]],
    ['account.impersonation_report', 'INVESTIGATED', 'SUPER_ADMIN', ['Screenshot/link showing the impersonation', 'Any other details that help identify it']],
    ['account.closure_request', 'ACTIONED', 'OPERATIONS', []],

    // platform — intermediary regime
    ['platform.app_fault', 'INVESTIGATED', 'SUPPORT', ['Screenshot or screen recording of the issue', 'What you were doing when it happened']],
    ['platform.notification_failure', 'INVESTIGATED', 'SUPPORT', ['Which notification you expected and when', 'Screenshot of your notification settings, if possible']],
    ['platform.location_issue', 'INVESTIGATED', 'SUPPORT', ['Screenshot of the incorrect location shown', 'What the correct location should be']],
    ['platform.data_incorrect', 'INVESTIGATED', 'SUPPORT', ['Screenshot of the incorrect information', 'The correct information']],
    ['platform.feedback', 'ACKNOWLEDGED', 'FEEDBACK_BOARD', []],

    // data — statutory regime
    ['data.access_request', 'STATUTORY', 'GRIEVANCE_OFFICER', []],
    ['data.correction_request', 'STATUTORY', 'GRIEVANCE_OFFICER', ['What information is incorrect', 'The correct information']],
    ['data.erasure_request', 'STATUTORY', 'GRIEVANCE_OFFICER', []],
    ['data.consent_withdrawal', 'STATUTORY', 'GRIEVANCE_OFFICER', []],
    ['data.breach_concern', 'STATUTORY', 'SUPER_ADMIN', ['Any details about what you believe was exposed', 'How you became aware of it']]
];

async function run() {
    await connectDB();

    let count = 0;
    for (const [category, resolutionClass, queue, evidenceRequired] of TABLE) {
        await ticketCategoryConfigService.setForCategory(category, { resolutionClass, queue, evidenceRequired });
        count++;
    }

    console.log(`Seeded ${count} ticket category configs (expected ${TABLE.length}).`);
    process.exit(0);
}

run().catch((err) => {
    console.error('Failed to seed ticket category config:', err);
    process.exit(1);
});
