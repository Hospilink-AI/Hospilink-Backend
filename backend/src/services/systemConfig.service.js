const SystemConfig = require('../models/SystemConfig');
const cacheService = require('./cache.service');

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
    'interview.hireCloseoutRepeatDays': 7
};

const CACHE_TTL_SECONDS = 300;

function cacheKeyFor(key) {
    return `config:interview:${key}`;
}

class SystemConfigService {
    // atDate omitted (or null) → "current effective value", which is the only
    // form that's cached. An explicit atDate is a historical lookup (used
    // when recomputing something against the setting that was in force on a
    // past event's date) and always hits the DB directly — these are rare
    // enough that caching them isn't worth the key-space complexity, and
    // caching "now" only would silently return a stale value for a real
    // historical query.
    async getEffective(key, atDate = null) {
        const isCurrent = !atDate;

        if (isCurrent) {
            const cached = await cacheService.get(cacheKeyFor(key));
            if (cached !== null) return cached.value;
        }

        const query = isCurrent ? { key } : { key, effectiveFrom: { $lte: atDate } };
        const row = await SystemConfig.findOne(query).sort({ effectiveFrom: -1 }).lean();
        const value = row ? row.value : DEFAULTS[key];

        if (isCurrent) {
            await cacheService.set(cacheKeyFor(key), { value }, CACHE_TTL_SECONDS);
        }

        return value;
    }

    async getManyEffective(keys, atDate = null) {
        const values = await Promise.all(keys.map(key => this.getEffective(key, atDate)));
        return keys.reduce((acc, key, i) => {
            acc[key] = values[i];
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

    get defaultKeys() {
        return Object.keys(DEFAULTS);
    }
}

module.exports = new SystemConfigService();
