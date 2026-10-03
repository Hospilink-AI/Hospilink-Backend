// How each notification type should look in the in-app notification centre
// and pop-ups. Every notification payload (live and stored) carries a
// `display` block built from this, so the apps render all types one way.
//   severity: 'info' | 'success' | 'warning' | 'critical'
//   category: 'duty' | 'recruitment' | 'support' | 'verification' | 'account' | 'admin'
//   action.screen: a screen key the apps map to a route; params come from the payload

const T = (title, category, severity, screen, icon) => ({ title, category, severity, screen, icon });

const TYPES = {
    // Duties: hospital side
    DUTY_CREATED: T('Duty posted', 'duty', 'success', 'duty_detail', 'calendar-plus'),
    EMERGENCY_REQUEST_ACKNOWLEDGED: T('Emergency request sent', 'duty', 'warning', 'duty_detail', 'siren'),
    STAFF_ASSIGNED: T('Staff assigned', 'duty', 'success', 'duty_detail', 'user-check'),
    STAFF_EN_ROUTE: T('Staff on the way', 'duty', 'info', 'duty_tracking', 'navigation'),
    STAFF_ON_SITE: T('Staff arrived', 'duty', 'success', 'duty_detail', 'map-pin'),
    DUTY_CANCELLED_BY_STAFF: T('Staff cancelled', 'duty', 'warning', 'duty_detail', 'calendar-x'),
    DUTY_RELIST_CAP_REACHED: T('Duty still unfilled', 'duty', 'critical', 'duty_detail', 'alert-triangle'),
    DUTY_UNASSIGNED_15MIN: T('Duty not yet filled', 'duty', 'warning', 'duty_detail', 'clock'),
    DUTY_UNFILLED_CRITICAL: T('Shift starting soon, still unfilled', 'duty', 'critical', 'duty_detail', 'alert-triangle'),
    DUTY_PENDING_CONFIRMATION: T('Confirm duty completion', 'duty', 'warning', 'duty_detail', 'clipboard-check'),
    DUTY_EXPIRED_UNFILLED: T('Duty expired unfilled', 'duty', 'warning', 'duty_detail', 'calendar-x'),
    DUTY_OPENED_TO_OTHERS: T('Duty opened to more doctors', 'duty', 'info', 'duty_detail', 'users'),
    RATE_HOSPITAL_PROMPT: T('Rate the hospital', 'duty', 'info', 'duty_review', 'star'),

    // Duties: staff side
    NEW_DUTY_OFFER: T('New duty near you', 'duty', 'info', 'duty_detail', 'briefcase'),
    EMERGENCY_DUTY_REQUEST: T('Emergency duty', 'duty', 'critical', 'duty_detail', 'siren'),
    DUTY_INVITE: T('Duty invitation', 'duty', 'success', 'duty_detail', 'mail'),
    DUTY_CONFIRMED: T('Duty confirmed', 'duty', 'success', 'duty_detail', 'check-circle'),
    NAVIGATE_TO_DUTY: T('Time to head out', 'duty', 'info', 'duty_tracking', 'navigation'),
    DUTY_IN_PROGRESS: T('Duty started', 'duty', 'info', 'duty_detail', 'play-circle'),
    DUTY_CANCELLED_BY_HOSPITAL: T('Duty cancelled by hospital', 'duty', 'warning', 'duty_detail', 'calendar-x'),
    DUTY_RELISTED: T('Duty open again', 'duty', 'info', 'duty_detail', 'refresh-cw'),
    DUTY_EDITED: T('Duty updated', 'duty', 'info', 'duty_detail', 'edit'),
    DUTY_COMPLETED: T('Duty completed', 'duty', 'success', 'duty_detail', 'check-circle'),
    DUTY_ASSIGNED_BY_ADMIN: T('Duty assigned', 'duty', 'success', 'duty_detail', 'user-check'),
    DUTY_MARKED_INCOMPLETE: T('Duty marked incomplete', 'duty', 'warning', 'duty_detail', 'alert-circle'),
    DUTY_STATUS_OVERRIDDEN: T('Duty status changed by HospiLink', 'duty', 'warning', 'duty_detail', 'shield'),
    END_OTP_REGENERATED: T('New end OTP sent', 'duty', 'info', 'duty_detail', 'key'),
    AVAILABILITY_EXPIRING: T('Update your availability', 'account', 'info', 'availability', 'calendar'),
    REVIEW_RECEIVED: T('New review', 'duty', 'info', 'reviews', 'star'),

    // Verification and account
    DOCUMENT_VERIFIED: T('Document verified', 'verification', 'success', 'documents', 'file-check'),
    DOCUMENT_AUTO_VERIFIED: T('Document verified', 'verification', 'success', 'documents', 'file-check'),
    DOCUMENT_REJECTED: T('Document rejected', 'verification', 'warning', 'documents', 'file-x'),
    HOSPITAL_VERIFIED: T('Hospital verified', 'verification', 'success', 'profile', 'badge-check'),
    HOSPITAL_REJECTED: T('Verification not approved', 'verification', 'warning', 'profile', 'x-circle'),
    STAFF_VERIFIED: T('Profile verified', 'verification', 'success', 'profile', 'badge-check'),
    STAFF_REJECTED: T('Verification not approved', 'verification', 'warning', 'profile', 'x-circle'),
    PASSWORD_CHANGED: T('Password changed', 'account', 'info', 'settings', 'lock'),
    ACCOUNT_SUSPENDED: T('Account suspended', 'account', 'critical', 'account_standing', 'slash'),
    ACCOUNT_ACTIVATED: T('Account restored', 'account', 'success', 'profile', 'check-circle'),
    PROFILE_AUTO_FILLED_FROM_RESUME: T('Profile filled from your resume', 'account', 'info', 'profile', 'file-text'),
    RESUME_ANALYZED: T('Resume reviewed', 'account', 'info', 'profile', 'file-text'),
    RATING_PENALTY_APPLIED: T('Rating penalty applied', 'account', 'warning', 'ticket_detail', 'trending-down'),
    RATING_PENALTY_REVERSED: T('Rating penalty reversed', 'account', 'success', 'ticket_detail', 'trending-up'),

    // Admin-only alerts
    NEW_HOSPITAL_REGISTRATION: T('New hospital registered', 'admin', 'info', 'admin_hospital', 'building'),
    NEW_STAFF_REGISTRATION: T('New staff registered', 'admin', 'info', 'admin_staff', 'user-plus'),
    HOSPITAL_VERIFIED_ADMIN: T('Hospital verified', 'admin', 'success', 'admin_hospital', 'badge-check'),
    HOSPITAL_REJECTED_ADMIN: T('Hospital rejected', 'admin', 'info', 'admin_hospital', 'x-circle'),
    STAFF_VERIFIED_ADMIN: T('Staff verified', 'admin', 'success', 'admin_staff', 'badge-check'),
    STAFF_REJECTED_ADMIN: T('Staff rejected', 'admin', 'info', 'admin_staff', 'x-circle'),
    EMERGENCY_ADMIN_ALERT: T('Emergency duty needs attention', 'admin', 'critical', 'admin_duty', 'siren'),
    STAFF_CANCELLATION_WATCHLIST: T('Staff on the cancellation watchlist', 'admin', 'warning', 'admin_staff', 'eye'),

    // Recruitment
    PROFILE_REQUIRED_FOR_APPLICATION: T('Complete your profile to apply', 'recruitment', 'info', 'profile', 'user'),
    RESUME_REQUIRED_FOR_APPLICATION: T('Upload your resume to apply', 'recruitment', 'info', 'profile', 'upload'),
    NEW_JOB_APPLICATION: T('New application', 'recruitment', 'info', 'application_detail', 'inbox'),
    APPLICATION_SHORTLISTED: T('You were shortlisted', 'recruitment', 'success', 'application_detail', 'star'),
    APPLICATION_REJECTED: T('Application update', 'recruitment', 'info', 'application_detail', 'x-circle'),
    APPLICATION_WITHDRAWN: T('Application withdrawn', 'recruitment', 'info', 'application_detail', 'log-out'),
    APPLICATION_HIRED: T('Hired', 'recruitment', 'success', 'application_detail', 'award'),
    VACANCY_CLOSED: T('Vacancy closed', 'recruitment', 'info', 'application_detail', 'archive'),
    SLOTS_OFFERED: T('Pick interview times', 'recruitment', 'info', 'application_detail', 'calendar'),
    OFFER_UNANSWERED_REMINDER: T('Interview times waiting for you', 'recruitment', 'warning', 'application_detail', 'clock'),
    OFFER_EXPIRED: T('Interview offer expired', 'recruitment', 'warning', 'application_detail', 'clock'),
    CANDIDATE_PICKED_SLOTS: T('Candidate picked times', 'recruitment', 'info', 'application_detail', 'calendar-check'),
    CONFIRMATION_PENDING_REMINDER: T('Confirm the interview time', 'recruitment', 'warning', 'application_detail', 'clock'),
    SELECTION_EXPIRED: T('Interview selection expired', 'recruitment', 'warning', 'application_detail', 'clock'),
    INTERVIEW_CONFIRMED: T('Interview confirmed', 'recruitment', 'success', 'application_detail', 'calendar-check'),
    INTERVIEW_REMINDER_24H: T('Interview tomorrow', 'recruitment', 'info', 'application_detail', 'bell'),
    INTERVIEW_REMINDER_1H: T('Interview in an hour', 'recruitment', 'warning', 'application_detail', 'bell'),
    MEETING_LINK_CHANGED: T('Interview link changed', 'recruitment', 'info', 'application_detail', 'link'),
    INTERVIEW_CANCELLED: T('Interview cancelled', 'recruitment', 'warning', 'application_detail', 'calendar-x'),
    INTERVIEW_RESCHEDULED: T('Interview rescheduled', 'recruitment', 'info', 'application_detail', 'calendar'),
    RESCHEDULE_REQUESTED: T('Reschedule requested', 'recruitment', 'info', 'application_detail', 'calendar'),
    MARKED_NO_SHOW: T('Marked as a no-show', 'recruitment', 'warning', 'application_detail', 'user-x'),
    HOSPITAL_NO_SHOW_REPORTED: T('No-show reported', 'recruitment', 'warning', 'application_detail', 'user-x'),
    JOB_OFFER_EXTENDED: T('Job offer', 'recruitment', 'success', 'application_detail', 'gift'),
    CONTACT_DETAILS_RELEASED: T('Contact details shared', 'recruitment', 'info', 'application_detail', 'phone'),
    HIRE_CLOSEOUT_PROMPT: T('Close out your vacancy', 'recruitment', 'info', 'vacancy_detail', 'archive'),

    // Support and disputes
    TICKET_CREATED: T('Ticket received', 'support', 'info', 'ticket_detail', 'life-buoy'),
    TICKET_RECATEGORIZED: T('Ticket updated', 'support', 'info', 'ticket_detail', 'tag'),
    TICKET_CLAIM_EXISTS: T('Response needed', 'support', 'warning', 'ticket_detail', 'message-square'),
    TICKET_RESPONSE_WINDOW_CLOSING: T('Response window closing', 'support', 'warning', 'ticket_detail', 'clock'),
    TICKET_OUTCOME_DECIDED: T('Ticket decided', 'support', 'info', 'ticket_detail', 'gavel'),
    TICKET_APPEAL_OUTCOME: T('Appeal decided', 'support', 'info', 'ticket_detail', 'gavel'),
    TICKET_INFO_REQUESTED: T('More information needed', 'support', 'warning', 'ticket_detail', 'help-circle'),
    TICKET_INFO_REQUEST_REMINDER: T('More information still needed', 'support', 'warning', 'ticket_detail', 'help-circle'),
    TICKET_CHAT_MESSAGE: T('New message', 'support', 'info', 'ticket_chat', 'message-circle'),
    PATTERN_FLAG_RAISED: T('Account review', 'support', 'warning', 'account_standing', 'flag'),
    SUSPENSION_PROPOSED: T('Suspension proposed', 'support', 'critical', 'account_standing', 'alert-octagon'),
    SUSPENSION_DECIDED: T('Account review decided', 'support', 'warning', 'account_standing', 'gavel')
};

const FALLBACK = T('HospiLink', 'account', 'info', 'notifications', 'bell');

// Screen parameters taken from the payload, so the app can open the right item
function paramsFor(screen, payload = {}) {
    const id = (obj) => (obj?.id ? String(obj.id) : null);
    switch (screen) {
        case 'duty_detail':
        case 'duty_tracking':
        case 'duty_review':
        case 'admin_duty':
            return { dutyId: id(payload.duty) };
        case 'application_detail':
            return { applicationId: id(payload.application), vacancyId: id(payload.vacancy) };
        case 'vacancy_detail':
            return { vacancyId: id(payload.vacancy) };
        case 'ticket_detail':
        case 'ticket_chat':
            return { ticketId: id(payload.ticket), ticketRef: payload.ticket?.ticketId || null };
        case 'admin_hospital':
            return { hospitalId: id(payload.hospital) };
        case 'admin_staff':
            return { staffId: id(payload.staff) };
        case 'account_standing':
            return { flagId: id(payload.flag) };
        default:
            return {};
    }
}

function describe(type, payload = {}) {
    const meta = TYPES[type] || FALLBACK;
    const params = Object.fromEntries(Object.entries(paramsFor(meta.screen, payload)).filter(([, v]) => v));
    return {
        title: meta.title,
        body: payload.message || null,
        severity: payload.priority === 'CRITICAL' ? 'critical' : meta.severity,
        category: meta.category,
        icon: meta.icon,
        action: { screen: meta.screen, params }
    };
}

module.exports = { describe, TYPES };
