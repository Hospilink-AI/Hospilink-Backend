/**
 * CONVERTED TO COMMONJS for backend compatibility
 */
/**
 * Ranker Module - Ranks job results by relevance and quality
 */
const logger = require('../utils/logger');
const config = require('../utils/config');

/**
 * Calculate role relevance score
 * @param {string} jobRole - Role from job listing
 * @param {string} searchRole - User's search query role
 * @returns {number} Score 0-100
 */
function calculateRoleRelevance(jobRole, searchRole) {
    if (!jobRole || !searchRole) return 0;

    const normalizedJob = jobRole.toLowerCase();
    const normalizedSearch = searchRole.toLowerCase();

    // Exact match
    if (normalizedJob === normalizedSearch) return 100;

    // Contains match
    if (normalizedJob.includes(normalizedSearch) || normalizedSearch.includes(normalizedJob)) {
        return 80;
    }

    // Keyword overlap
    const jobWords = new Set(normalizedJob.split(/\s+/).filter(w => w.length > 2));
    const searchWords = normalizedSearch.split(/\s+/).filter(w => w.length > 2);

    let matchCount = 0;
    for (const word of searchWords) {
        if (jobWords.has(word)) matchCount++;
    }

    if (searchWords.length === 0) return 0;
    return Math.round((matchCount / searchWords.length) * 60);
}

/**
 * Calculate location relevance score
 * @param {string} jobLocation - Location from job listing
 * @param {string} searchLocation - User's search query location
 * @returns {number} Score 0-100
 */
function calculateLocationRelevance(jobLocation, searchLocation) {
    if (!jobLocation || !searchLocation) return 0;

    const normalizedJob = jobLocation.toLowerCase();
    const normalizedSearch = searchLocation.toLowerCase();

    // Exact match
    if (normalizedJob === normalizedSearch) return 100;

    // Contains match
    if (normalizedJob.includes(normalizedSearch) || normalizedSearch.includes(normalizedJob)) {
        return 80;
    }

    // City aliases
    const aliases = {
        'mumbai': ['bombay'],
        'chennai': ['madras'],
        'kolkata': ['calcutta'],
        'bengaluru': ['bangalore'],
        'pune': ['poona']
    };

    for (const [city, cityAliases] of Object.entries(aliases)) {
        if (normalizedSearch.includes(city)) {
            for (const alias of cityAliases) {
                if (normalizedJob.includes(alias)) return 70;
            }
        }
    }

    return 0;
}

/**
 * Calculate signal strength score based on contact info availability
 * WhatsApp = highest close rate, then phone, then email
 * @param {Object} job - Job object
 * @returns {number} Score 0-100
 */
function calculateSignalStrength(job) {
    let score = 0;

    // WhatsApp = highest close rate signal (instant messaging, personal)
    if (job.whatsapp) score += 40;
    // Phone = high value (direct contact)
    if (job.phones && job.phones.length > 0) score += 30;
    // Email = good value (formal, may take longer)
    if (job.emails && job.emails.length > 0) score += 20;
    // HR contact name = helpful context
    if (job.hr_contact) score += 8;
    // Apply link = fallback option
    if (job.apply_link) score += 2;

    return Math.min(score, 100);
}

/**
 * Parse and score recency w/ Decay Formula
 * @param {string} dateStr - Date string from job
 * @returns {number} Recency score 0-100
 */
function calculateRecency(dateStr) {
    if (!dateStr) return 0;

    let daysOld = 30; // Default fallback

    try {
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
            const msPerDay = 1000 * 60 * 60 * 24;
            const msDiff = Date.now() - date.getTime();
            daysOld = Math.floor(msDiff / msPerDay);
        } else {
            // Text heuristics
            const text = dateStr.toLowerCase();
            if (text.includes('today') || text.includes('hour') || text.includes('just')) daysOld = 0;
            else if (text.includes('yesterday')) daysOld = 1;
            else if (text.match(/(\d+)\s*days?/)) daysOld = parseInt(text.match(/(\d+)\s*days?/)[1]);
            else if (text.match(/(\d+)\s*weeks?/)) daysOld = parseInt(text.match(/(\d+)\s*weeks?/)[1]) * 7;
        }
    } catch (e) {
        // Fallback to default
    }

    // Decay Formula: max(0, 100 - (days * decayRate))
    // Default decay: 7 points per day -> 0 score at ~2 weeks
    const decay = config.recencyDecayRate || 7;
    const score = Math.max(0, 100 - (daysOld * decay));

    return score;
}

/**
 * Calculate composite ranking score for a job
 * @param {Object} job - Job object
 * @param {string} searchRole - User's search role
 * @param {string} searchLocation - User's search location
 * @returns {Object} Job with rankingScore added
 */
function calculateRankingScore(job, searchRole, searchLocation) {
    const roleScore = calculateRoleRelevance(job.role, searchRole);
    const locationScore = calculateLocationRelevance(job.location, searchLocation);
    const signalScore = calculateSignalStrength(job);
    const recencyScore = calculateRecency(job.posted_date);
    const confidenceScore = job.confidence_score || 0;

    // Weighted composite score
    const rankingScore = Math.round(
        (roleScore * 0.25) +
        (locationScore * 0.20) +
        (signalScore * 0.30) +
        (recencyScore * 0.10) +
        (confidenceScore * 0.15)
    );

    return {
        ...job,
        ranking_score: rankingScore, // Mapped to schema field
        rankingDetails: {
            role: roleScore,
            location: locationScore,
            signal: signalScore,
            recency: recencyScore,
            confidence: confidenceScore
        }
    };
}

/**
 * Rank an array of jobs
 * @param {Object[]} jobs - Array of job objects
 * @param {string} searchRole - User's search role
 * @param {string} searchLocation - User's search location
 * @returns {Object[]} Sorted array with rankings
 */
function rankJobs(jobs, searchRole, searchLocation) {
    logger.info(`Ranking ${jobs.length} jobs`);

    // Calculate scores for all jobs
    const rankedJobs = jobs.map(job =>
        calculateRankingScore(job, searchRole, searchLocation)
    );

    // Sort by ranking score (highest first)
    rankedJobs.sort((a, b) => b.ranking_score - a.ranking_score);

    // Add rank position
    rankedJobs.forEach((job, index) => {
        job.rank = index + 1;
    });

    logger.info('Ranking completed', {
        total: rankedJobs.length,
        topScore: rankedJobs[0]?.rankingScore || 0,
        avgScore: Math.round(rankedJobs.reduce((sum, j) => sum + j.rankingScore, 0) / rankedJobs.length) || 0
    });

    return rankedJobs;
}

module.exports = {
    rankJobs,
    calculateRankingScore,
    calculateRoleRelevance,
    calculateLocationRelevance,
    calculateSignalStrength,
    calculateRecency
};
// module.exports = rankJobs;