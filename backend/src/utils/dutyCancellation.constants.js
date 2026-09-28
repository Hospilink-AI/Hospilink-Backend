// Cancellation reason enums — must stay in sync with the
// `cancellation.reason` enum on Duty.js.
const HOSPITAL_CANCEL_REASONS = ['no_longer_needed', 'found_alternative', 'emergency_resolved', 'budget_constraints', 'other_hospital'];
const STAFF_CANCEL_REASONS = ['emergency', 'illness', 'scheduling_conflict', 'transportation_issue', 'other_staff'];
const HOSPITAL_OTHER_REASON = 'other_hospital';
const STAFF_OTHER_REASON = 'other_staff';

// A staff member cannot cancel inside this many minutes of duty start —
// past this point it's treated as a no-show, not a cancellation.
const STAFF_CANCEL_CUTOFF_MINUTES = 30;

// Cancelling between STAFF_CANCEL_CUTOFF_MINUTES and this many minutes
// before start is the "late cancellation" band — still allowed, but
// triggers the one-time rate boost on relist.
const LATE_CANCELLATION_BAND_MINUTES = 90;

// Rate boost applied once per duty when a cancellation lands in the late band.
const RATE_BOOST_FRACTION = 0.10;

// A relisted duty's new rate rounds up to the nearest this many rupees.
const RATE_ROUNDING_UNIT = 10;

// Urgency escalates one level per relist, capped here — never auto-set to
// 'emergency' (that unlocks canEditPricing() and must stay a manual,
// deliberate choice — see Duty.js#canEditPricing).
const URGENCY_LEVELS = ['low', 'medium', 'high', 'emergency'];
const URGENCY_AUTO_ESCALATION_CEILING = 'high';

// After this many relists on the same duty, stop escalating/boosting — it
// has a problem a rate rise won't fix; flag it for a human instead.
const RELIST_CAP = 3;

// Notification radius for the widened staff broadcast on relist — one step
// wider than the 50km default used for new-duty creation.
const RELIST_NOTIFICATION_RADIUS_KM = 75;

// Repeat push schedule (spec §05): minutes-since-relist at which pushes 2
// and 3 fire, stopping once the duty enters the staff cancellation cutoff
// (it becomes a no-show concern at that point, not a fill-it-faster one).
const REPEAT_PUSH_SCHEDULE_MINUTES = [15, 45];

// Watchlist thresholds a signal to look, never an automatic
// consequence. Read by autoRelist.service.js#countStaffCancellations and,
// later, the admin watchlist endpoints.
const STAFF_WATCHLIST_WINDOW_DAYS = 30;
const STAFF_WATCHLIST_THRESHOLD_COUNT = 2; // more than 2 late-band cancellations in the window
const PAIR_WATCHLIST_THRESHOLD_COUNT = 5; // recurrences of the same cancel-then-accept pair
const HOSPITAL_WATCHLIST_MULTIPLIER = 2; // relist rate above this many times the platform average

module.exports = {
    HOSPITAL_CANCEL_REASONS, STAFF_CANCEL_REASONS,
    HOSPITAL_OTHER_REASON, STAFF_OTHER_REASON,
    STAFF_CANCEL_CUTOFF_MINUTES, LATE_CANCELLATION_BAND_MINUTES,
    RATE_BOOST_FRACTION, RATE_ROUNDING_UNIT,
    URGENCY_LEVELS, URGENCY_AUTO_ESCALATION_CEILING,
    RELIST_CAP, RELIST_NOTIFICATION_RADIUS_KM, REPEAT_PUSH_SCHEDULE_MINUTES,
    STAFF_WATCHLIST_WINDOW_DAYS, STAFF_WATCHLIST_THRESHOLD_COUNT,
    PAIR_WATCHLIST_THRESHOLD_COUNT, HOSPITAL_WATCHLIST_MULTIPLIER
};
