const JobApplication = require('../models/JobApplication');
const systemConfigService = require('./systemConfig.service');
const { ConflictError } = require('../middleware/error.middleware');

// All candidate no-show consequences (rating deduction, match-score
// multiplier, offer suspension) are computed live from JobApplication's
// interview.noShow records over a trailing window — never stamped onto
// MedicalStaff as a stored/decayed number. This is what makes "decay after
// 180 days" and "a disputed no-show applies no penalty while open" true by
// construction: once an event falls outside the window, or its dispute is
// voided, it simply stops being counted the next time this runs. Nothing
// needs to be un-applied retroactively.
//
// Scope note: this pass wires the suspension gate into offerSlots() (this
// module) and the match-score multiplier into the apply-time frozen snapshot
// (jobApplication.service.js#applyToVacancy). Folding the multiplier into
// the *live* staff-browse ranked list (jobVacancy.service.js#listForStaff)
// and the marketplace rating display (wherever averageRating is rendered)
// are deliberate follow-ups — both are existing, already-shipped read paths
// this module intentionally does not reach into.
class NoShowPenaltyService {
    // Counts confirmed candidate no-shows in the trailing `days` window,
    // excluding any still under an open dispute (held, per spec) — a voided
    // dispute is also excluded (the mark was wrong), an upheld one still counts.
    async countRecentNoShows(staffId, days) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        return JobApplication.countDocuments({
            staff: staffId,
            'interview.noShow.by': 'candidate',
            'interview.noShow.markedAt': { $gte: cutoff },
            'interview.noShow.disputeStatus': { $in: ['none', 'upheld'] }
        });
    }

    async getMostRecentNoShowDate(staffId, days) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const latest = await JobApplication.findOne({
            staff: staffId,
            'interview.noShow.by': 'candidate',
            'interview.noShow.markedAt': { $gte: cutoff },
            'interview.noShow.disputeStatus': { $in: ['none', 'upheld'] }
        }).sort({ 'interview.noShow.markedAt': -1 }).select('interview.noShow.markedAt').lean();
        return latest?.interview?.noShow?.markedAt || null;
    }

    // { score } -> multiplied score, per the spec: "A multiplier of 0.95 per
    // confirmed no-show inside the trailing 180 days, applied after the
    // weighted score and floored at 0.85."
    async applyMatchScoreMultiplier(staffId, rawScore) {
        if (rawScore == null) return rawScore;

        const [windowDays, multiplier, floor] = await Promise.all([
            systemConfigService.getEffective('interview.penaltyDecayDays'),
            systemConfigService.getEffective('interview.noShowScoreMultiplier'),
            systemConfigService.getEffective('interview.noShowScoreFloor')
        ]);

        const recentCount = await this.countRecentNoShows(staffId, windowDays);
        if (recentCount === 0) return rawScore;

        const factor = Math.max(floor, Math.pow(multiplier, recentCount));
        return Math.round(rawScore * factor);
    }

    // Cumulative rating deduction to subtract from a candidate's displayed
    // marketplace rating — capped, per spec. Read-only computation; wiring
    // this into the actual rating display is the follow-up noted above.
    async getRatingDeduction(staffId) {
        const [deductionPerEvent, cap, windowDays] = await Promise.all([
            systemConfigService.getEffective('interview.noShowRatingDeduction'),
            systemConfigService.getEffective('interview.noShowRatingDeductionCap'),
            systemConfigService.getEffective('interview.penaltyDecayDays')
        ]);
        const recentCount = await this.countRecentNoShows(staffId, windowDays);
        return Math.min(cap, deductionPerEvent * recentCount);
    }

    // Suspension is active when the candidate has reached the trigger count
    // within the trigger window AND the most recent qualifying no-show fell
    // within the last `suspensionDays` — i.e. the 30-day clock runs from the
    // most recent no-show that kept them at/above the threshold.
    async isOfferSuspended(staffId) {
        const [triggerCount, triggerWindowDays, suspensionDays] = await Promise.all([
            systemConfigService.getEffective('interview.noShowSuspensionTriggerCount'),
            systemConfigService.getEffective('interview.noShowSuspensionTriggerWindowDays'),
            systemConfigService.getEffective('interview.noShowSuspensionDays')
        ]);

        const recentCount = await this.countRecentNoShows(staffId, triggerWindowDays);
        if (recentCount < triggerCount) return { suspended: false };

        const mostRecent = await this.getMostRecentNoShowDate(staffId, triggerWindowDays);
        if (!mostRecent) return { suspended: false };

        const suspendedUntil = new Date(new Date(mostRecent).getTime() + suspensionDays * 24 * 60 * 60 * 1000);
        return { suspended: suspendedUntil > new Date(), suspendedUntil };
    }

    // Called from interviewScheduling.service.js#offerSlots — "browsing and
    // applying are unaffected," this only blocks a hospital from being able
    // to send this specific candidate a fresh slot offer.
    async assertNotSuspended(staffId) {
        const { suspended, suspendedUntil } = await this.isOfferSuspended(staffId);
        if (suspended) {
            throw new ConflictError(
                `This candidate's ability to receive new interview offers is temporarily suspended until ${suspendedUntil.toISOString()} due to repeated no-shows.`
            );
        }
    }
}

module.exports = new NoShowPenaltyService();
