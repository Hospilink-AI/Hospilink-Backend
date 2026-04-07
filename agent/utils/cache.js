/**
 * Cache Module - In-memory caching for performance
 * Provides high-performance caching for search results, stats, and job data
 * 
 * CONVERTED TO COMMONJS for backend compatibility
 */
const config = require('./config');
const { logger } = require('./logger');

const inMemoryCache = new Map();
const inMemoryCacheTimers = new Map();

const CACHE_PREFIXES = {
    SEARCH: 'search:',
    STATS: 'stats:',
    JOBS: 'jobs:',
    RATE_LIMIT: 'rl:'
};

const DEFAULT_TTL = {
    SEARCH: 300,
    STATS: 60,
    JOBS: 120
};

/**
 * Placeholder for backward compatibility
 */
async function connectRedis() {
    logger.info('Using in-memory cache system');
    return true;
}

/**
 * Placeholder for backward compatibility
 */
async function disconnectRedis() {
    return true;
}

function setInMemory(key, value, ttlSeconds) {
    inMemoryCache.set(key, value);

    if (inMemoryCacheTimers.has(key)) {
        clearTimeout(inMemoryCacheTimers.get(key));
    }

    const timer = setTimeout(() => {
        inMemoryCache.delete(key);
        inMemoryCacheTimers.delete(key);
    }, ttlSeconds * 1000);

    // Ensure timer doesn't keep the process alive
    if (timer.unref) {
        timer.unref();
    }

    inMemoryCacheTimers.set(key, timer);
}

function getInMemory(key) {
    return inMemoryCache.get(key) || null;
}

function deleteInMemory(key) {
    inMemoryCache.delete(key);
    if (inMemoryCacheTimers.has(key)) {
        clearTimeout(inMemoryCacheTimers.get(key));
        inMemoryCacheTimers.delete(key);
    }
}

async function set(key, value, ttlSeconds = 300) {
    const serialized = JSON.stringify(value);
    setInMemory(key, serialized, ttlSeconds);
    return true;
}

async function get(key) {
    const value = getInMemory(key);
    return value ? JSON.parse(value) : null;
}

async function del(key) {
    deleteInMemory(key);
}

async function delPattern(pattern) {
    const searchPattern = pattern.replace('*', '');
    for (const key of inMemoryCache.keys()) {
        if (key.includes(searchPattern)) {
            deleteInMemory(key);
        }
    }
}

async function cacheSearchResults(role, location, results, ttl = DEFAULT_TTL.SEARCH) {
    const key = `${CACHE_PREFIXES.SEARCH}${role.toLowerCase()}:${location.toLowerCase()}`;
    await set(key, results, ttl);
}

async function getCachedSearchResults(role, location) {
    const key = `${CACHE_PREFIXES.SEARCH}${role.toLowerCase()}:${location.toLowerCase()}`;
    return await get(key);
}

async function cacheStats(stats, ttl = DEFAULT_TTL.STATS) {
    await set(`${CACHE_PREFIXES.STATS}global`, stats, ttl);
}

async function getCachedStats() {
    return await get(`${CACHE_PREFIXES.STATS}global`);
}

async function invalidateStatsCache() {
    await del(`${CACHE_PREFIXES.STATS}global`);
}

async function cacheJobs(criteria, jobs, ttl = DEFAULT_TTL.JOBS) {
    const key = `${CACHE_PREFIXES.JOBS}${typeof criteria === 'string' ? criteria : JSON.stringify(criteria)}`;
    await set(key, jobs, ttl);
}

async function getCachedJobs(criteria) {
    const key = `${CACHE_PREFIXES.JOBS}${typeof criteria === 'string' ? criteria : JSON.stringify(criteria)}`;
    return await get(key);
}

async function invalidateJobsCache() {
    await delPattern(`${CACHE_PREFIXES.JOBS}*`);
}

function getRedisClient() {
    return null;
}

function isConnected() {
    return true; // Always consider in-memory as "connected"
}

function getCacheStats() {
    return {
        type: 'in-memory',
        connected: true,
        inMemorySize: inMemoryCache.size
    };
}

module.exports = {
    connectRedis,
    disconnectRedis,
    set,
    get,
    del,
    delPattern,
    cacheSearchResults,
    getCachedSearchResults,
    cacheStats,
    getCachedStats,
    invalidateStatsCache,
    cacheJobs,
    getCachedJobs,
    invalidateJobsCache,
    getRedisClient,
    isConnected,
    getCacheStats,
    CACHE_PREFIXES,
    DEFAULT_TTL
};
