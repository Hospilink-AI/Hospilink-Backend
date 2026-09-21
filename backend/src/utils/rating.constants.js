// Algorithmic rating — Phase 1. Which ticket categories can carry an
// APPLY_RATING_PENALTY action, and how many points each is worth. A fixed
// map, not admin-editable via SystemConfig — same precedent as
// ticket.constants.js's PRIORITY_SLA: a category-tied number is code, a
// general policy knob (window length, cap, floor) is SystemConfig.
const RATING_PENALTY_POINTS_BY_CATEGORY = {
    'duty.late_arrival': 0.1,
    'duty.no_show_staff': 0.25,
    'duty.no_show_hospital': 0.25,
    'duty.conduct_staff': 0.4,
    'duty.conduct_hospital': 0.4
};

const RATING_PENALTY_CATEGORIES = Object.keys(RATING_PENALTY_POINTS_BY_CATEGORY);

module.exports = { RATING_PENALTY_CATEGORIES, RATING_PENALTY_POINTS_BY_CATEGORY };
