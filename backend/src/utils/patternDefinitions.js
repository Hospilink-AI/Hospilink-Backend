// spec §10's repeat-behaviour threshold table, as data. Tiers are checked
// highest-first by patternEngine.service.js so a party who's already past
// the suspension-proposal tier doesn't also get a redundant lower-tier flag
// for the same underlying pattern.
//
// categories: null means "any category counts" (only tickets_against_party
// uses this). The flagged party is always ticket.raisedAgainst — every
// pattern here is about the party a claim was raised against, so there's no
// separate role filter to configure per entry.
//
// Interview no-shows (spec: "3 in 180 days -> 30-day slot-offer
// suspension") are deliberately NOT here — noShowPenalty.service.js already
// implements exactly this, live, with the same numbers
// (noShowSuspensionTriggerCount/WindowDays/SuspensionDays), wired into
// offerSlots(). A second path would just be a second source of truth.
const PATTERN_DEFINITIONS = [
    {
        patternType: 'staff_no_show',
        categories: ['duty.no_show_staff'],
        upheldOnly: true,
        tiers: [
            { windowDays: 180, thresholdCount: 5, raises: 'suspension_proposal', reviewFloor: 'OPERATIONS' },
            { windowDays: 90, thresholdCount: 3, raises: 'operations_flag', reviewFloor: 'OPERATIONS' }
        ]
    },
    {
        patternType: 'staff_conduct',
        categories: ['duty.conduct_staff'],
        upheldOnly: true,
        tiers: [
            { windowDays: 180, thresholdCount: 2, raises: 'suspension_proposal', reviewFloor: 'SUPER_ADMIN' }
        ]
    },
    {
        patternType: 'staff_quality',
        categories: ['duty.work_quality'],
        upheldOnly: true,
        tiers: [
            { windowDays: 180, thresholdCount: 3, raises: 'operations_flag', reviewFloor: 'OPERATIONS' }
        ]
    },
    {
        patternType: 'hospital_late_non_payment',
        categories: ['payment.non_payment'],
        upheldOnly: true,
        tiers: [
            { windowDays: 90, thresholdCount: 3, raises: 'operations_flag', reviewFloor: 'OPERATIONS' }
        ]
    },
    {
        patternType: 'hospital_conditions',
        categories: ['duty.working_conditions'],
        upheldOnly: true,
        tiers: [
            { windowDays: 180, thresholdCount: 3, raises: 'operations_flag', reviewFloor: 'OPERATIONS' }
        ]
    },
    {
        patternType: 'hospital_conduct',
        categories: ['duty.conduct_hospital'],
        upheldOnly: true,
        tiers: [
            { windowDays: 180, thresholdCount: 2, raises: 'suspension_proposal', reviewFloor: 'SUPER_ADMIN' }
        ]
    },
    {
        patternType: 'scope_of_practice',
        categories: ['duty.scope_of_practice'],
        upheldOnly: true,
        tiers: [
            // "Any single case" — window is nominal/very large rather than infinite,
            // simplest way to express "no real window" against the same schema shape.
            { windowDays: 36500, thresholdCount: 1, raises: 'operations_flag', reviewFloor: 'SUPER_ADMIN' }
        ]
    },
    {
        patternType: 'safety',
        categories: ['safety.patient_incident', 'safety.staff_incident', 'safety.harassment'],
        upheldOnly: true,
        tiers: [
            { windowDays: 36500, thresholdCount: 1, raises: 'precautionary_restriction', reviewFloor: 'SUPER_ADMIN' }
        ]
    },
    {
        patternType: 'tickets_against_party',
        categories: null,
        upheldOnly: false,
        tiers: [
            { windowDays: 30, thresholdCount: 10, raises: 'operations_flag', reviewFloor: 'OPERATIONS' }
        ]
    }
];

module.exports = { PATTERN_DEFINITIONS };
