const SystemConfig = require('../models/SystemConfig');
const cacheService = require('./cache.service');
const { validateValue, CROSS_KEY_RULES } = require('../utils/systemConfig.rules');

// Hardcoded fallbacks — used only when a key has never been seeded into
// SystemConfig (e.g. a fresh environment before `scripts/seedInterviewConfig.js`
// has run). Every one of these mirrors a real seeded row so the interview
// flow never goes down on a missing seed, it just runs on documented
// defaults. Values match documents/JOB_APPLICATION_INTERVIEW_HIRING_PROCESS.pdf §14.
const DEFAULTS = {
    'interview.slotDurationDefault': 30,
    'interview.slotsPerOfferMin': 3,
    'interview.slotsPerOfferMax': 8,
    'interview.schedulingWindowMinHours': 24,
    'interview.schedulingWindowMaxDays': 21,
    'interview.offerExpiryDays': 21,
    'interview.confirmationExpiryDays': 21,
    'interview.nudgeScheduleDays': [3, 10, 18],
    'interview.joinWindowBeforeMin': 10,
    'interview.joinWindowAfterMin': 60,
    'interview.lateChangeThresholdHours': 2,
    'interview.rescheduleCap': 2,
    'interview.noShowGraceMin': 15,
    'interview.outcomeRecordingWindowDays': 7,
    'interview.noShowRatingDeduction': 0.25,
    'interview.noShowRatingDeductionCap': 0.75,
    'interview.noShowScoreMultiplier': 0.95,
    'interview.noShowScoreFloor': 0.85,
    'interview.noShowSuspensionTriggerCount': 3,
    'interview.noShowSuspensionTriggerWindowDays': 180,
    'interview.noShowSuspensionDays': 30,
    'interview.penaltyDecayDays': 180,
    'interview.disputeWindowDays': 7,
    'interview.lateChangeOpsFlagCount': 3,
    'interview.lateChangeOpsFlagWindowDays': 90,
    'interview.postCloseApplicantRetentionDays': 31,
    'interview.hireCloseoutFirstPromptDays': 7,
    'interview.hireCloseoutRepeatDays': 7,

    // Disputes & Support module (spec §16). Ack/decide SLA windows are NOT
    // here — those are marked "No — statutory" in the spec and live as
    // fixed constants in utils/ticket.constants.js (REGIME_SLA) instead,
    // since changing them is a legal-review event, not a settings edit.
    // 3-tier respondent window (spec update) — keyed off _dutyUrgencyTier's
    // NORMAL/WITHIN_A_DAY/LIVE_OR_IMMINENT bands. Still admin-editable, only
    // the tier count/numbers changed. The old flat imminentDutyThresholdHours
    // (12h) is gone — dead since Day 1 moved that boundary into
    // DUTY_URGENCY_THRESHOLDS in ticket.constants.js. Claim timeout is also
    // gone from here — it's priority-tied now, see
    // CLAIM_TIMEOUT_MINUTES_BY_PRIORITY in ticket.constants.js instead.
    'ticket.respondentWindowNormalHours': 24,
    'ticket.respondentWindowWithinADayHours': 4,
    'ticket.respondentWindowLiveHours': 1,
    'ticket.awaitingRaiserAutoCloseDays': 5,
    'ticket.reopenWindowDays': 30,
    'ticket.evidenceMaxFiles': 5,
    'ticket.evidenceMaxSizeMB': 10,
    'ticket.botConfidenceThresholdEn': 0.75,
    'ticket.botConfidenceThresholdHiMr': 0.85,
    'ticket.appealWindowDays': 7,
    'ticket.appealWindowSuspensionDays': 14,
    'ticket.suspensionResponseWindowDays': 14,
    'ticket.precautionaryRestrictionCapDays': 7,
    'ticket.payoutFreezeCapDays': 7,
    'ticket.clawbackCapPercent': 25,
    'ticket.paymentSignoffThresholdINR': 10000,
    'ticket.freeTextLimit': 1000,
    'ticket.retentionYearsConsequenceBearing': 3,
    'ticket.retentionYearsOther': 1,
    'payments.mediatedPayoutsEnabled': false,

    // Algorithmic rating (Phase 1) — general policy knobs, admin-editable
    // without a deploy. Per-category penalty point values are NOT here —
    // those are a fixed constant (RATING_PENALTY_POINTS_BY_CATEGORY in
    // utils/rating.constants.js), same precedent as ticket priority SLAs.
    'rating.penaltyWindowDays': 180,
    'rating.penaltyCapTotal': 0.75,
    'rating.floor': 1.0,
    'rating.dampingConfidenceCount': 5,
    // Phase 3 — blind/simultaneous review reveal. A review stays visible
    // only to its own author until either the sibling review for the same
    // duty also exists, or this many days have passed.
    'rating.blindRevealTimeoutDays': 14
};

const CACHE_TTL_SECONDS = 300;

function cacheKeyFor(key) {
    return `config:interview:${key}`;
}

class SystemConfigService {
    async getEffective(key, atDate = null) {
        const values = await this.getManyEffective([key], atDate);
        return values[key];
    }

    // atDate omitted (or null) → "current effective value", which is the only
    // form that's cached. An explicit atDate is a historical lookup (used
    // when recomputing something against the setting that was in force on a
    // past event's date) and always hits the DB directly — these are rare
    // enough that caching them isn't worth the key-space complexity, and
    // caching "now" only would silently return a stale value for a real
    // historical query.
    //
    // Either way a row only counts once its effectiveFrom has arrived — "now"
    // for a current lookup, atDate for a historical one — so a change an admin
    // scheduled for next month stays dormant until then. This is the single
    // place that rule is applied; getEffective delegates here.
    //
    // Cache misses are resolved together in one aggregation (newest eligible
    // row per key, served by the { key, effectiveFrom } index) rather than one
    // query per key, so a cold cache costs one round trip however many keys
    // are asked for. A scheduled change that becomes due can lag by up to
    // CACHE_TTL_SECONDS for a key whose value is already cached.
    async getManyEffective(keys, atDate = null) {
        const isCurrent = !atDate;
        const resolved = {};
        let misses = keys;

        if (isCurrent) {
            const cached = await Promise.all(keys.map(key => cacheService.get(cacheKeyFor(key))));
            misses = keys.filter((key, i) => {
                if (cached[i] === null) return true;
                resolved[key] = cached[i].value;
                return false;
            });
        }

        if (misses.length > 0) {
            const rows = await SystemConfig.aggregate([
                { $match: { key: { $in: misses }, effectiveFrom: { $lte: atDate || new Date() } } },
                { $sort: { key: 1, effectiveFrom: -1 } },
                { $group: { _id: '$key', value: { $first: '$value' } } }
            ]);
            const found = new Map(rows.map(row => [row._id, row.value]));

            await Promise.all(misses.map(async key => {
                const value = found.has(key) ? found.get(key) : DEFAULTS[key];
                resolved[key] = value;
                if (isCurrent) {
                    await cacheService.set(cacheKeyFor(key), { value }, CACHE_TTL_SECONDS);
                }
            }));
        }

        return keys.reduce((acc, key) => {
            acc[key] = resolved[key];
            return acc;
        }, {});
    }

    async getAllEffective() {
        return this.getManyEffective(Object.keys(DEFAULTS));
    }

    // Inserts a new version — never edits a prior row. `effectiveFrom`
    // defaults to now (takes effect immediately); admins can also schedule a
    // future change by passing a later date.
    async setValue(key, value, { effectiveFrom = new Date(), createdBy = null } = {}) {
        const row = await SystemConfig.create({ key, value, effectiveFrom, createdBy });
        await cacheService.del(cacheKeyFor(key));
        return row;
    }

    async getHistory(key) {
        return SystemConfig.find({ key }).sort({ effectiveFrom: -1 }).lean();
    }

    isKnownKey(key) {
        return Object.prototype.hasOwnProperty.call(DEFAULTS, key);
    }

    // Admin-edit guardrail — returns an error message, or null when `value` is
    // acceptable for `key`. Deliberately NOT called from setValue: internal
    // writers (e.g. ticketCategoryConfig, whose keys and object values aren't
    // in DEFAULTS) go through setValue directly and have their own shape.
    async validateUpdate(key, value) {
        const error = validateValue(key, value, DEFAULTS[key]);
        if (error) return error;

        for (const rule of CROSS_KEY_RULES) {
            if (!rule.keys.includes(key)) continue;

            const siblings = await this.getManyEffective(rule.keys.filter(k => k !== key));
            const proposed = { ...siblings, [key]: value };
            if (!rule.check(...rule.keys.map(k => proposed[k]))) return rule.message;
        }

        return null;
    }

    get defaultKeys() {
        return Object.keys(DEFAULTS);
    }
}

module.exports = new SystemConfigService();
