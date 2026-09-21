const Review = require('../models/Review');
const Ticket = require('../models/Ticket');
const cacheService = require('./cache.service');
const systemConfigService = require('./systemConfig.service');
const { RATING_PENALTY_CATEGORIES } = require('../utils/rating.constants');

// Read-heavy, slow-changing — a plain TTL is enough, no invalidation-on-
// write needed (same reasoning as knowledgeBase.service.js's cache).
const PLATFORM_AVERAGE_CACHE_TTL_SECONDS = 3600;
// Defensible neutral midpoint for a fresh environment with no reviews yet —
// never lets getPlatformAverage blow up on an empty aggregate.
const PLATFORM_AVERAGE_FALLBACK = 3;

function cacheKeyFor(reviewType) {
    return `rating:platformAverage:${reviewType}`;
}

class RatingAlgorithmService {
    // Platform-wide mean computed directly from Review documents, grouped
    // by direction — never by averaging the already-averaged
    // MedicalStaff/Hospital.averageRating fields, which would distort the
    // number (an average of averages weights every staff member equally
    // regardless of review count, instead of every review equally).
    async getPlatformAverage(reviewType) {
        const cached = await cacheService.get(cacheKeyFor(reviewType));
        if (cached !== null) return cached;

        const [result] = await Review.aggregate([
            { $match: { reviewType } },
            { $group: { _id: null, avg: { $avg: '$rating' } } }
        ]);
        const average = result ? Number(result.avg.toFixed(2)) : PLATFORM_AVERAGE_FALLBACK;

        await cacheService.set(cacheKeyFor(reviewType), average, PLATFORM_AVERAGE_CACHE_TTL_SECONDS);
        return average;
    }

    // Bayesian blend — smooth, not a hard cutoff. At count=0 this is
    // exactly platformAverage; as count grows past confidenceCount it
    // converges toward rawAverage.
    _dampedAverage(rawAverage, count, platformAverage, confidenceCount) {
        return ((platformAverage * confidenceCount) + (rawAverage * count)) / (confidenceCount + count);
    }

    // profile.user is sometimes a raw ObjectId, sometimes a populated
    // {_id, name, email} doc (any site using .populate('user', ...)) —
    // normalized once, here, so no call site has to remember to unwrap it.
    // A populated object passed straight into a Ticket.find filter would
    // silently match zero tickets instead of throwing, which is worse.
    _normalizeUserId(user) {
        return user?._id || user;
    }

    // Batched version of the single-user penalty lookup — one $in query
    // for candidates, one $in query for reversals, instead of two queries
    // PER user. Keyed off resolutionActions[].executedAt, not
    // ticket.updatedAt (which bumps again on a later appeal, making a
    // stale penalty look recent). Returns a Map<userIdString, incident[]>
    // so callers can look up each profile's own list independently.
    async _qualifyingPenaltiesForMany(userIds, windowDays) {
        const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
        const byUser = new Map(userIds.map(id => [id.toString(), []]));
        if (userIds.length === 0) return byUser;

        const candidates = await Ticket.find({
            'raisedAgainst.user': { $in: userIds },
            category: { $in: RATING_PENALTY_CATEGORIES },
            resolutionActions: {
                $elemMatch: { action: 'APPLY_RATING_PENALTY', executedAt: { $gte: windowStart } }
            }
        }).select('ticketId category resolutionActions raisedAgainst.user').lean();

        if (candidates.length === 0) return byUser;

        const candidateIds = candidates.map(t => t._id);
        const reversals = await Ticket.find({
            appealOf: { $in: candidateIds },
            resolutionActions: { $elemMatch: { action: 'REVERSE_RATING_PENALTY' } }
        }).select('appealOf').lean();
        const reversedIds = new Set(reversals.map(r => r.appealOf.toString()));

        for (const t of candidates) {
            if (reversedIds.has(t._id.toString())) continue;
            const entry = t.resolutionActions.find(a => a.action === 'APPLY_RATING_PENALTY' && a.executedAt && a.executedAt >= windowStart);
            const userKey = t.raisedAgainst.user.toString();
            const bucket = byUser.get(userKey);
            if (!bucket) continue; // defensive — shouldn't happen given the $in filter above
            bucket.push({
                ticketId: t.ticketId,
                category: t.category,
                points: entry?.details?.ratingDelta || 0,
                executedAt: entry?.executedAt || null
            });
        }
        return byUser;
    }

    async _qualifyingPenalties(userId, windowDays) {
        const byUser = await this._qualifyingPenaltiesForMany([this._normalizeUserId(userId)], windowDays);
        return byUser.get(this._normalizeUserId(userId).toString()) || [];
    }

    // profiles: an array of MedicalStaff or Hospital documents (each needs
    // .user, .averageRating, .totalRatings). reviewType: which direction of
    // review these profiles receive — 'hospital_to_staff' for MedicalStaff,
    // 'staff_to_hospital' for Hospital. Returns one result per input
    // profile, same order, each independently correct — one shared
    // getPlatformAverage() call and one batched penalty query for the
    // whole array, not one of each per profile.
    async getEffectiveRatingsForMany(profiles, reviewType) {
        if (profiles.length === 0) return [];

        const [platformAverage, windowDays, capTotal, floor, confidenceCount] = await Promise.all([
            this.getPlatformAverage(reviewType),
            systemConfigService.getEffective('rating.penaltyWindowDays'),
            systemConfigService.getEffective('rating.penaltyCapTotal'),
            systemConfigService.getEffective('rating.floor'),
            systemConfigService.getEffective('rating.dampingConfidenceCount')
        ]);

        const userIds = profiles.map(p => this._normalizeUserId(p.user));
        const penaltiesByUser = await this._qualifyingPenaltiesForMany(userIds, windowDays);

        return profiles.map((profile, i) => {
            const rawAverage = profile.averageRating || 0;
            const reviewCount = profile.totalRatings || 0;
            const dampedAverage = Number(this._dampedAverage(rawAverage, reviewCount, platformAverage, confidenceCount).toFixed(2));

            const qualifyingIncidents = penaltiesByUser.get(userIds[i].toString()) || [];
            const rawPenaltyTotal = qualifyingIncidents.reduce((sum, incident) => sum + incident.points, 0);
            const penaltyCapped = rawPenaltyTotal > capTotal;
            const penaltyTotal = Number(Math.min(rawPenaltyTotal, capTotal).toFixed(2));

            const ratingShown = Number(Math.max(floor, Math.min(5, dampedAverage - penaltyTotal)).toFixed(2));

            return {
                ratingShown,
                breakdown: {
                    rawAverage, reviewCount, platformAverage, dampedAverage,
                    penaltyTotal, penaltyCapped, qualifyingIncidents
                }
            };
        });
    }

    async getEffectiveRating(profile, reviewType) {
        const [result] = await this.getEffectiveRatingsForMany([profile], reviewType);
        return result;
    }
}

module.exports = new RatingAlgorithmService();
