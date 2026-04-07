/**
 * Search Module - SerpAPI integration for job search
 */
const config = require('../utils/config');
const { logger } = require('../utils/logger');
const { searchAllSerper } = require('./search_serper');

/**
 * Simple in-memory cache for search results (avoids re-hitting APIs for same role+location)
 */
const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getCachedSearch(role, location) {
    const key = `${role.toLowerCase()}::${location.toLowerCase()}`;
    const entry = searchCache.get(key);
    if (entry && Date.now() - entry.ts < SEARCH_CACHE_TTL_MS) {
        logger.info('Search cache hit', { role, location });
        return entry.data;
    }
    return null;
}

function setCachedSearch(role, location, data) {
    const key = `${role.toLowerCase()}::${location.toLowerCase()}`;
    searchCache.set(key, { data, ts: Date.now() });
    // Evict old entries if cache grows large
    if (searchCache.size > 100) {
        const oldest = [...searchCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        searchCache.delete(oldest[0]);
    }
}

/**
 * Generate optimized search queries from user input
 * These queries are designed to find DIRECT hospital/company career pages
 * with contact information, rather than job aggregator sites.
 * 
 * @param {string} role - Job role (e.g., "staff nurse")
 * @param {string} location - Location (e.g., "Pune")
 * @returns {string[]} Array of search queries
 */
function generateQueries(role, location, deepSearch = false) {
    // Detect if role is nursing-related for specialized queries
    const isNursing = /nurse|nursing|gnm|anm|bsc\s*nurs/i.test(role);

    // Core 3 queries — highest-signal patterns only for speed
    const baseQueries = [
        `"${role}" "${location}" hospital careers email HR contact`,
        `${role} ${location} hiring WhatsApp number apply`,
        `${role} vacancy ${location} "hr@" OR "careers@" OR "recruitment@"`,
    ];

    // Extra nursing queries — only run in deepSearch mode or when initial results are thin
    const nursingQueries = (isNursing && deepSearch) ? [
        `staff nurse whatsapp ${location} vacancy hiring`,
        `GNM ANM vacancy ${location} hospital resume email`,
        `nursing bureau ${location} hiring staff nurse contact`,
        `hospital hiring direct walk-in ${location} nurse vacancy`,
    ] : [];

    const queries = [...baseQueries, ...nursingQueries];

    logger.debug('Generated search queries', {
        queries,
        count: queries.length,
        isNursing,
        deepSearch
    });
    return queries;
}

/**
 * Extract organic results from SearchAPI response — kept for reference only
 * @deprecated Not used when SearchAPI is disabled
 */
// function extractOrganicResults(response) { ... }
/**
 * Filter out blocked domains from URL list
 * @param {Object[]} results - Array of { url, ... }
 * @returns {Object[]} Filtered results
 */
function filterBlockedDomains(results) {
    return results.filter(result => {
        try {
            const hostname = new URL(result.url).hostname.toLowerCase();
            const isBlocked = config.blockedDomains?.some(domain => hostname.includes(domain));
            if (isBlocked) {
                logger.debug(`Filtering out blocked domain: ${result.url}`);
            }
            return !isBlocked;
        } catch {
            return true;
        }
    });
}

/**
 * Calculate priority score for a URL based on domain
 * @param {string} url - URL to score
 * @returns {number} Priority score (higher = better)
 */
function calculatePriority(url) {
    let score = 0;
    const lowerUrl = url.toLowerCase();

    // Check against priority domains
    for (const domain of config.priorityDomains) {
        if (lowerUrl.includes(domain)) {
            score += 10;
            break;
        }
    }

    // Bonus for Indian domains
    if (lowerUrl.includes('.in') || lowerUrl.includes('.co.in')) {
        score += 5;
    }

    // Bonus for job-related keywords in URL
    const jobKeywords = ['job', 'career', 'vacancy', 'hiring', 'recruit'];
    for (const keyword of jobKeywords) {
        if (lowerUrl.includes(keyword)) {
            score += 3;
            break;
        }
    }

    // Check for aggregators (give them a decent score, but lower than direct carrier pages)
    if (config.aggregatorDomains?.some(domain => lowerUrl.includes(domain))) {
        score += 5;
    }

    return score;
}

/**
 * Main search function - SerpAPI only
 * @param {string} role - Job role
 * @param {string} location - Location
 * @returns {Promise<Object>} { urls: [], totalFound: number }
 */
async function search(role, location) {
    logger.info('Starting job search', { role, location });

    const cached = getCachedSearch(role, location);
    if (cached) return cached;

    const queries = generateQueries(role, location);
    const serperResults = await searchAllSerper(queries);

    logger.info('SerpAPI search completed', { results: serperResults.length });

    const urlMap = new Map();
    for (const result of serperResults) {
        if (!urlMap.has(result.url)) {
            urlMap.set(result.url, {
                ...result,
                priority: calculatePriority(result.url),
                source: 'serpapi'
            });
        }
    }

    const uniqueResults = filterBlockedDomains(Array.from(urlMap.values()))
        .sort((a, b) => b.priority - a.priority)
        .slice(0, config.maxUrlsPerSearch);

    const blockedCount = urlMap.size - uniqueResults.length;

    logger.info('Search completed', {
        totalUnique: urlMap.size,
        blockedFiltered: blockedCount,
        finalUrls: uniqueResults.length
    });

    const result = {
        urls: uniqueResults,
        totalFound: urlMap.size,
        blockedFiltered: blockedCount
    };

    setCachedSearch(role, location, result);
    return result;
}

module.exports = { search, generateQueries, calculatePriority, filterBlockedDomains };