/**
 * CONVERTED TO COMMONJS for backend compatibility
 */
/**
 * Queue Module - Production-grade Direct Processing
 * Handles concurrent job search requests using native asynchronous task processing.
 * Designed for reliable background execution without external dependencies.
 */
const { v4: uuidv4 } = require('uuid');
const config = require('../utils/config');
const logger = require('../utils/logger');
const cache = require('../utils/cache');

let globalProcessFunction = null;
const pendingSearches = new Map();
const MAX_PENDING_SEARCHES = 100;
const SEARCH_TIMEOUT_MS = 120000;

/**
 * Simplified queue initialization - no Redis required
 */
async function initializeQueue(processFunction) {
    globalProcessFunction = processFunction;
    logger.info('Queue initialized (Direct Mode)');
    return true;
}

/**
 * Simplified enqueue - executes the process function directly but asynchronously
 */
async function enqueueSearch(role, location, options = {}) {
    const searchId = uuidv4();

    if (!globalProcessFunction) {
        throw new Error('Queue not properly initialized: missing process function');
    }

    if (pendingSearches.size >= MAX_PENDING_SEARCHES) {
        throw new Error('Search capacity reached. Please try again later.');
    }

    logger.info('Processing search directly', { searchId, role, location });

    // Execute directly but async to mock a background job behavior
    // We use setImmediate or Promise.resolve().then to push it to the end of the event loop
    Promise.resolve().then(async () => {
        try {
            const result = await globalProcessFunction(role, location, options);
            const pending = pendingSearches.get(searchId);
            if (pending) {
                pending.resolve(result);
                pendingSearches.delete(searchId);
            }
        } catch (error) {
            const pending = pendingSearches.get(searchId);
            if (pending) {
                pending.reject(error);
                pendingSearches.delete(searchId);
            }
            logger.error(`Direct search task ${searchId} failed`, { error: error.message });
        }
    });

    return {
        queued: true,
        searchId,
        jobId: 'direct-' + searchId,
        position: 0,
        mode: 'direct'
    };
}

/**
 * Wait for a specific search ID to complete
 */
async function waitForSearch(searchId, timeoutMs = SEARCH_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const pending = pendingSearches.get(searchId);
            if (pending) {
                pendingSearches.delete(searchId);
                reject(new Error('Search timeout'));
            }
        }, timeoutMs);

        // Ensure timer doesn't keep the process alive
        if (timer.unref) {
            timer.unref();
        }

        pendingSearches.set(searchId, {
            resolve: (result) => {
                clearTimeout(timer);
                resolve(result);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            }
        });
    });
}

/**
 * Get position (always 0 in direct mode as it starts immediately)
 */
async function getQueuePosition(jobId) {
    return 0;
}

/**
 * Get simplified stats
 */
async function getQueueStats() {
    return {
        enabled: true,
        mode: 'direct',
        waiting: 0,
        active: pendingSearches.size,
        completed: 0,
        failed: 0,
        pending: pendingSearches.size
    };
}

/**
 * Simplified cleanup
 */
async function closeQueue() {
    for (const [searchId, pending] of pendingSearches) {
        pending.reject(new Error('System shutting down'));
    }
    pendingSearches.clear();
    logger.info('Queue services stopped');
}

function isQueueEnabled() {
    return true;
}

module.exports = {
    initializeQueue,
    enqueueSearch,
    waitForSearch,
    getQueueStats,
    getQueuePosition,
    closeQueue,
    isQueueEnabled
};