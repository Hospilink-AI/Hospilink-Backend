/**
 * Agent Cache Service
 * Implements intelligent caching to check database before performing new searches
 */

const { getJobs, searchJobs, getStats } = require('../modules/storage');
const logger = require('../utils/logger');

/**
 * Cache configuration
 */
const CACHE_CONFIG = {
    // How fresh should cached results be (in hours)
    FRESHNESS_THRESHOLD_HOURS: 24,
    
    // Minimum number of jobs to consider cache valid
    MIN_JOBS_THRESHOLD: 5,
    
    // Maximum age for jobs to be considered (in days)
    MAX_JOB_AGE_DAYS: 7,
    
    // Similarity threshold for location matching (0-1)
    LOCATION_SIMILARITY_THRESHOLD: 0.7,
    
    // Role matching keywords
    ROLE_KEYWORDS: {
        'nurse': ['nurse', 'nursing', 'rn', 'lpn', 'staff nurse', 'registered nurse'],
        'doctor': ['doctor', 'physician', 'md', 'medical officer', 'consultant'],
        'technician': ['technician', 'tech', 'lab tech', 'radiology tech', 'medical tech'],
        'pharmacist': ['pharmacist', 'pharmacy', 'pharm', 'clinical pharmacist'],
        'therapist': ['therapist', 'physiotherapist', 'occupational therapist', 'speech therapist']
    }
};

/**
 * Generate cache key for search parameters
 */
function generateCacheKey(role, location) {
    const normalizedRole = role.toLowerCase().trim();
    const normalizedLocation = location.toLowerCase().trim();
    return `${normalizedRole}|${normalizedLocation}`;
}

/**
 * Check if role matches using keywords and similarity
 */
function isRoleMatch(searchRole, jobRole) {
    if (!searchRole || !jobRole) return false;
    
    const searchRoleLower = searchRole.toLowerCase();
    const jobRoleLower = jobRole.toLowerCase();
    
    // Exact match
    if (searchRoleLower === jobRoleLower) return true;
    
    // Contains match
    if (jobRoleLower.includes(searchRoleLower) || searchRoleLower.includes(jobRoleLower)) {
        return true;
    }
    
    // Keyword-based matching
    for (const [category, keywords] of Object.entries(CACHE_CONFIG.ROLE_KEYWORDS)) {
        const searchInCategory = keywords.some(keyword => searchRoleLower.includes(keyword));
        const jobInCategory = keywords.some(keyword => jobRoleLower.includes(keyword));
        
        if (searchInCategory && jobInCategory) {
            return true;
        }
    }
    
    return false;
}

/**
 * Check if location matches using similarity
 */
function isLocationMatch(searchLocation, jobLocation) {
    if (!searchLocation || !jobLocation) return false;
    
    const searchLower = searchLocation.toLowerCase().trim();
    const jobLower = jobLocation.toLowerCase().trim();
    
    // Exact match
    if (searchLower === jobLower) return true;
    
    // Extract city names (remove state, country, etc.)
    const searchCity = searchLower.split(',')[0].trim();
    const jobCity = jobLower.split(',')[0].trim();
    
    // City match
    if (searchCity === jobCity) return true;
    
    // Contains match
    if (jobLower.includes(searchCity) || searchLower.includes(jobCity)) {
        return true;
    }
    
    // Calculate simple similarity (Jaccard similarity for words)
    const searchWords = new Set(searchLower.split(/\s+/));
    const jobWords = new Set(jobLower.split(/\s+/));
    
    const intersection = new Set([...searchWords].filter(x => jobWords.has(x)));
    const union = new Set([...searchWords, ...jobWords]);
    
    const similarity = intersection.size / union.size;
    return similarity >= CACHE_CONFIG.LOCATION_SIMILARITY_THRESHOLD;
}

/**
 * Check if cached jobs are fresh enough
 */
function areJobsFresh(jobs) {
    if (!jobs || jobs.length === 0) return false;
    
    const now = new Date();
    const thresholdTime = new Date(now.getTime() - (CACHE_CONFIG.FRESHNESS_THRESHOLD_HOURS * 60 * 60 * 1000));
    
    // Check if at least 70% of jobs are fresh
    const freshJobs = jobs.filter(job => {
        const scrapedAt = new Date(job.scraped_at || job.createdAt);
        return scrapedAt >= thresholdTime;
    });
    
    return freshJobs.length >= (jobs.length * 0.7);
}

/**
 * Filter jobs by age
 */
function filterJobsByAge(jobs) {
    const now = new Date();
    const maxAge = new Date(now.getTime() - (CACHE_CONFIG.MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000));
    
    return jobs.filter(job => {
        const scrapedAt = new Date(job.scraped_at || job.createdAt);
        return scrapedAt >= maxAge && job.is_active !== false;
    });
}

/**
 * Main cache check function
 * Returns cached jobs if available and fresh, null otherwise
 */
async function checkCache(role, location, options = {}) {
    const startTime = Date.now();
    
    try {
        logger.info('Checking cache for search', { role, location });
        
        // Step 1: Try exact match first
        const exactJobs = await getJobs({
            role: { $regex: new RegExp(role, 'i') },
            location: { $regex: new RegExp(location, 'i') },
            is_active: true
        }, 100);
        
        if (exactJobs.length >= CACHE_CONFIG.MIN_JOBS_THRESHOLD) {
            const filteredJobs = filterJobsByAge(exactJobs);
            
            if (filteredJobs.length >= CACHE_CONFIG.MIN_JOBS_THRESHOLD && areJobsFresh(filteredJobs)) {
                logger.info('Cache hit - exact match', { 
                    role, 
                    location, 
                    jobCount: filteredJobs.length,
                    cacheTime: Date.now() - startTime
                });
                
                return {
                    jobs: filteredJobs,
                    source: 'cache_exact',
                    cached: true,
                    freshness: 'fresh'
                };
            }
        }
        
        // Step 2: Try broader search with role/location matching
        const allRecentJobs = await getJobs({
            is_active: true,
            scraped_at: { 
                $gte: new Date(Date.now() - (CACHE_CONFIG.MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000))
            }
        }, 500);
        
        const matchingJobs = allRecentJobs.filter(job => {
            const roleMatch = isRoleMatch(role, job.role);
            const locationMatch = isLocationMatch(location, job.location);
            return roleMatch && locationMatch;
        });
        
        if (matchingJobs.length >= CACHE_CONFIG.MIN_JOBS_THRESHOLD) {
            const freshJobs = matchingJobs.filter(job => areJobsFresh([job]));
            
            if (freshJobs.length >= CACHE_CONFIG.MIN_JOBS_THRESHOLD) {
                logger.info('Cache hit - fuzzy match', { 
                    role, 
                    location, 
                    jobCount: freshJobs.length,
                    cacheTime: Date.now() - startTime
                });
                
                return {
                    jobs: freshJobs,
                    source: 'cache_fuzzy',
                    cached: true,
                    freshness: 'fresh'
                };
            }
        }
        
        // Step 3: Check if we have stale but usable results
        if (matchingJobs.length > 0) {
            logger.info('Cache hit - stale results available', { 
                role, 
                location, 
                jobCount: matchingJobs.length,
                cacheTime: Date.now() - startTime
            });
            
            return {
                jobs: matchingJobs,
                source: 'cache_stale',
                cached: true,
                freshness: 'stale'
            };
        }
        
        // Step 4: No suitable cache found
        logger.info('Cache miss - no suitable results found', { 
            role, 
            location,
            exactJobs: exactJobs.length,
            allJobs: allRecentJobs.length,
            cacheTime: Date.now() - startTime
        });
        
        return null;
        
    } catch (error) {
        logger.error('Cache check failed', { 
            error: error.message, 
            role, 
            location 
        });
        return null;
    }
}

/**
 * Get cache statistics
 */
async function getCacheStats() {
    try {
        const stats = await getStats();
        const now = new Date();
        
        // Calculate freshness distribution
        const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        const oneWeekAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
        
        const recentJobs = await getJobs({
            is_active: true,
            scraped_at: { $gte: oneWeekAgo }
        }, 1000);
        
        const fresh = recentJobs.filter(job => new Date(job.scraped_at) >= oneDayAgo).length;
        const stale = recentJobs.length - fresh;
        
        return {
            ...stats,
            cache: {
                fresh_jobs: fresh,
                stale_jobs: stale,
                cache_hit_potential: fresh >= CACHE_CONFIG.MIN_JOBS_THRESHOLD ? 'high' : 'low',
                freshness_threshold_hours: CACHE_CONFIG.FRESHNESS_THRESHOLD_HOURS,
                min_jobs_threshold: CACHE_CONFIG.MIN_JOBS_THRESHOLD
            }
        };
    } catch (error) {
        logger.error('Failed to get cache stats', { error: error.message });
        return null;
    }
}

/**
 * Invalidate cache for specific search parameters
 */
async function invalidateCache(role, location) {
    // This could be implemented to mark specific jobs as stale
    // For now, we rely on the natural aging mechanism
    logger.info('Cache invalidation requested', { role, location });
}

module.exports = {
    checkCache,
    getCacheStats,
    invalidateCache,
    generateCacheKey,
    isRoleMatch,
    isLocationMatch,
    areJobsFresh,
    CACHE_CONFIG
};