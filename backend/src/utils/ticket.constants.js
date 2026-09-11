// Central taxonomy for the Disputes & Support module. One flat category
// enum backs Ticket.category; domain, resolutionClass and queue are all
// derived from it (via ticketCategoryConfig.service) rather than set
// independently, so a ticket can never carry a category/domain pair that
// doesn't exist in the spec's taxonomy.

const DOMAINS = ['duty', 'payment', 'safety', 'jobs', 'account', 'platform', 'data'];

// 3-letter code per domain, used to build ticketId: HL-<CODE>-<YYMM>-<seq>
const DOMAIN_CODES = {
    duty: 'DTY',
    payment: 'PAY',
    safety: 'SFT',
    jobs: 'JOB',
    account: 'ACC',
    platform: 'PLT',
    data: 'DAT'
};

const CATEGORIES = [
    // duty — platform-worker regime (17)
    'duty.end_otp_unverified', 'duty.start_otp_failure', 'duty.no_show_staff',
    'duty.no_show_hospital', 'duty.late_arrival', 'duty.early_departure',
    'duty.cancellation_staff', 'duty.cancellation_hospital', 'duty.details_mismatch',
    'duty.status_change_request', 'duty.details_change_request', 'duty.work_quality',
    'duty.working_conditions', 'duty.scope_of_practice', 'duty.conduct_staff',
    'duty.conduct_hospital', 'duty.credential_challenge',

    // payment — platform-worker regime, consequence actions gated (6)
    'payment.non_payment', 'payment.amount_mismatch', 'payment.overtime_unpaid',
    'payment.deduction_disputed', 'payment.mode_dispute', 'payment.refund_request',

    // safety — platform-worker regime, every case P1 (3)
    'safety.patient_incident', 'safety.staff_incident', 'safety.harassment',

    // jobs — intermediary regime (8)
    'jobs.application_revoke', 'jobs.interview_reschedule', 'jobs.interview_cancellation',
    'jobs.interview_no_show', 'jobs.ai_score_challenge', 'jobs.parsed_data_incorrect',
    'jobs.listing_misleading', 'jobs.offer_reneged',

    // account — intermediary regime (7)
    'account.verification_delay', 'account.verification_rejected', 'account.rating_challenge',
    'account.suspension_appeal', 'account.access_locked', 'account.impersonation_report',
    'account.closure_request',

    // platform — intermediary regime (5)
    'platform.app_fault', 'platform.notification_failure', 'platform.location_issue',
    'platform.data_incorrect', 'platform.feedback',

    // data — statutory regime (5)
    'data.access_request', 'data.correction_request', 'data.erasure_request',
    'data.consent_withdrawal', 'data.breach_concern'
];
// 51 categories total (17+6+3+8+7+5+5) — the client's spec subtitle says
// "forty-one"; its own tables add up to 51. Built from the tables, since
// those carry the actual class/route data per category. Flagged to confirm
// with the client which is right.

const RESOLUTION_CLASSES = ['ADJUDICATED', 'ACTIONED', 'INVESTIGATED', 'ACKNOWLEDGED', 'STATUTORY'];

const SUBJECT_TYPES = ['DUTY', 'APPLICATION', 'INTERVIEW', 'VACANCY', 'ACCOUNT', 'PAYMENT', 'NONE'];

// Matches ActivityLog.actor.role exactly, for consistency across the two audit trails.
const PARTY_ROLES = ['staff', 'hospital', 'admin', 'system'];

const SOURCES = ['CHATBOT', 'IN_APP_FORM', 'ADMIN_CREATED', 'SYSTEM_GENERATED'];

const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];

const QUEUES = ['SUPPORT', 'OPERATIONS', 'SUPER_ADMIN', 'GRIEVANCE_OFFICER', 'FEEDBACK_BOARD'];

const STATUSES = [
    'NEW', 'TRIAGE', 'OPEN', 'IN_REVIEW', 'AWAITING_RAISER', 'AWAITING_RESPONDENT',
    'PENDING_APPROVAL', 'ESCALATED', 'RESOLVED', 'REJECTED', 'WITHDRAWN', 'DUPLICATE',
    'AUTO_CLOSED', 'APPEALED', 'REOPENED', 'CLOSED'
];

// Statuses whose SLA clock is Running or Paused (spec §05) — i.e. not yet
// terminal. Doubles as the dedup filter: "one open ticket per raiser,
// subject and category" means at most one row in this set at a time.
const ACTIVE_STATUSES = [
    'NEW', 'TRIAGE', 'OPEN', 'IN_REVIEW', 'AWAITING_RAISER', 'AWAITING_RESPONDENT',
    'PENDING_APPROVAL', 'ESCALATED', 'REOPENED'
];

const PAUSED_STATUSES = ['AWAITING_RAISER', 'AWAITING_RESPONDENT'];

// Outcome is deliberately separate from status (§05) so analytics can tell a
// housekeeping NOT_ACTIONED apart from a money-losing DECLINED even though
// both close the ticket. §01's class-closing table and §05's own outcome
// list disagree with each other in the source spec — §01 has RESOLVED for
// INVESTIGATED, §05's list has NO_FAULT_FOUND instead, and §05's list omits
// ACKNOWLEDGED even though §01 names it as the ACKNOWLEDGED class's only
// closing value. Reconciled here by keeping both RESOLVED and
// NO_FAULT_FOUND as distinct outcomes and adding ACKNOWLEDGED back in —
// flagged to confirm with the client.
const RESOLUTION_OUTCOMES = [
    'UPHELD', 'PARTLY_UPHELD', 'DECLINED',
    'ACTIONED', 'NOT_ACTIONED',
    'RESOLVED', 'NO_FAULT_FOUND', 'KNOWN_ISSUE', 'CANNOT_REPRODUCE',
    'ACKNOWLEDGED',
    'FULFILLED', 'REFUSED_WITH_REASON',
    'LAPSED', 'WITHDRAWN', 'DUPLICATE',
    // Appeal-only outcomes (spec §11) — valid when Ticket.appealOf is set,
    // regardless of resolutionClass. UPHELD is shared with the regular
    // ADJUDICATED set above (same enum value, different meaning in this
    // context: "the original decision stands").
    'OVERTURNED', 'VARIED'
];

// Outcomes legal on an appeal ticket (ticket.appealOf set) — checked
// instead of VALID_OUTCOMES_BY_CLASS, since an appeal's validity doesn't
// depend on the original ticket's resolutionClass.
const APPEAL_OUTCOMES = ['UPHELD', 'OVERTURNED', 'VARIED'];

// §09 — executed transactionally inside the same write that closes the
// ticket. LIVE run today; GATED are inert until mediated payouts ship.
const RESOLUTION_ACTIONS_LIVE = [
    'CLOSE_DUTY_AT_STATED_TIME', 'SET_DUTY_STATUS', 'UNLOCK_OTP',
    'REVERSE_RATING_PENALTY', 'APPLY_RATING_PENALTY', 'SUPPRESS_REVIEW',
    'REINSTATE_APPLICATION', 'REVOKE_APPLICATION', 'RESCHEDULE_INTERVIEW',
    'RECOMPUTE_MATCH_SCORE', 'CORRECT_PROFILE_FIELD', 'ISSUE_WARNING',
    'FLAG_FOR_SUSPENSION', 'APPLY_PRECAUTIONARY_RESTRICTION', 'RESTORE_ACCOUNT',
    'RECORD_ONLY'
];
const RESOLUTION_ACTIONS_GATED = [
    'HOLD_PAYOUT', 'RELEASE_PAYOUT', 'ADJUST_PAYOUT',
    'RECOVER_FROM_FUTURE_PAYOUT', 'REFUND_HOSPITAL'
];
const RESOLUTION_ACTIONS = [...RESOLUTION_ACTIONS_LIVE, ...RESOLUTION_ACTIONS_GATED];

const EVIDENCE_PARTIES = ['raiser', 'respondent', 'admin'];

// Which resolutionOutcome values are legal for a ticket's resolutionClass
// (spec §01's per-class "closes as" column). Enforced in ticket.service —
// the enum on Ticket.resolutionOutcome only rules out garbage values, not
// class/outcome mismatches.
const VALID_OUTCOMES_BY_CLASS = {
    ADJUDICATED: ['UPHELD', 'PARTLY_UPHELD', 'DECLINED'],
    ACTIONED: ['ACTIONED', 'NOT_ACTIONED'],
    INVESTIGATED: ['RESOLVED', 'NO_FAULT_FOUND', 'KNOWN_ISSUE', 'CANNOT_REPRODUCE'],
    ACKNOWLEDGED: ['ACKNOWLEDGED'],
    STATUTORY: ['FULFILLED', 'REFUSED_WITH_REASON']
};

// DECLINED/REFUSED_WITH_REASON mean the raiser's claim didn't succeed —
// REJECTED. Every other real outcome is a completed, executed decision —
// RESOLVED. (WITHDRAWN/LAPSED/DUPLICATE are set directly by their own flows,
// never through this map.)
const TERMINAL_STATUS_BY_OUTCOME = {
    DECLINED: 'REJECTED',
    REFUSED_WITH_REASON: 'REJECTED'
};
const DEFAULT_TERMINAL_STATUS = 'RESOLVED';

// §02's three service-level regimes. Ack/decide windows are marked
// "No — statutory" in §16 (not admin-editable), so they're fixed constants
// here rather than SystemConfig rows — a regime change is a legal-review
// event, not a settings-screen edit.
const REGIME_SLA = {
    intermediary: { ackHours: 24, decideDays: 15 },
    platform_worker: { ackHours: 24, decideDays: 14 },
    statutory: { ackHours: 72, decideDays: 90 }
};

const REGIME_BY_DOMAIN = {
    duty: 'platform_worker',
    payment: 'platform_worker',
    safety: 'platform_worker',
    jobs: 'intermediary',
    account: 'intermediary',
    platform: 'intermediary',
    data: 'statutory'
};

// Spec update — priority-based operational SLA targets (P1-P4). These now
// back slaFirstReplyBy/slaDecideBy; REGIME_SLA above stays as the legal
// backstop (slaCeilingBy) rather than the operational target. Expressed in
// minutes/hours at the low end for precision (5min/15min P1/P2 first-reply
// targets don't fit cleanly into an hours-only shape).
const PRIORITY_SLA = {
    P1: { firstReplyMinutes: 5, decideHours: 2 },
    P2: { firstReplyMinutes: 15, decideHours: 8 },
    P3: { firstReplyMinutes: 30, decideHours: 48 },
    P4: { firstReplyMinutes: 120, decideHours: 72 }
};

// data.* categories sit outside the priority-driven SLA ladder — their
// operational targets come from here instead of PRIORITY_SLA, even though
// they still carry a (P4, queue-sort-only) priority value.
const DATA_DOMAIN_SLA = { firstReplyHours: 1, decideDays: 7 };

// Shared boundaries for _dutyUrgencyTier — backs both the P1/P2 priority
// waterfall here and Day 2's respondent-window tiers.
const DUTY_URGENCY_THRESHOLDS = { liveOrImminentHours: 4, withinADayHours: 24 };

// Priority-tied, like PRIORITY_SLA — claim-timeout is now "how urgent is
// this ticket", not a flat number, so it lives here rather than as a
// SystemConfig row (spec update).
const CLAIM_TIMEOUT_MINUTES_BY_PRIORITY = { P1: 30, P2: 30, P3: 120, P4: 120 };

module.exports = {
    DOMAINS, DOMAIN_CODES, CATEGORIES, RESOLUTION_CLASSES, SUBJECT_TYPES,
    PARTY_ROLES, SOURCES, PRIORITIES, QUEUES, STATUSES, ACTIVE_STATUSES,
    PAUSED_STATUSES, RESOLUTION_OUTCOMES, RESOLUTION_ACTIONS,
    RESOLUTION_ACTIONS_LIVE, RESOLUTION_ACTIONS_GATED, EVIDENCE_PARTIES,
    REGIME_SLA, REGIME_BY_DOMAIN, VALID_OUTCOMES_BY_CLASS,
    TERMINAL_STATUS_BY_OUTCOME, DEFAULT_TERMINAL_STATUS, APPEAL_OUTCOMES,
    PRIORITY_SLA, DATA_DOMAIN_SLA, DUTY_URGENCY_THRESHOLDS,
    CLAIM_TIMEOUT_MINUTES_BY_PRIORITY
};
