const rateLimit = require('express-rate-limit');
const { MemoryStore } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redisClient = require('../config/redis');
const cacheService = require('../services/cache.service');
const logger = require('../utils/logger');

/**
 * Counts in Redis, so every server task shares one count. If Redis can't be
 * reached the count falls back to this task's memory instead of failing the
 * request. The Redis store loads its scripts when created, so it's created on
 * first use, not when this file loads.
 */
class SharedStore {
    constructor(name) {
        this.name = name;
        this.prefix = `rl:${name}:`;
        this.memory = new MemoryStore();
        this.redis = null;
        this.warned = false;
    }

    init(options) {
        this.options = options;
        this.windowMs = options.windowMs;
        this.memory.init(options);
    }

    _redisStore() {
        if (!this.redis) {
            const store = new RedisStore({
                prefix: this.prefix,
                sendCommand: async (...args) => {
                    const client = await redisClient.getClientAsync();
                    return client.call(...args);
                }
            });
            // Loaded again on first use if Redis wasn't there yet
            store.incrementScriptSha.catch(() => {});
            store.getScriptSha.catch(() => {});
            store.init(this.options);
            this.redis = store;
        }
        return this.redis;
    }

    async _shared(method, key) {
        try {
            const result = await this._redisStore()[method](key);
            this.warned = false;
            return result;
        } catch (err) {
            if (!this.warned) {
                logger.warn(`Rate limit ${this.name}: Redis unavailable, counting on this server only (${err.message})`);
                this.warned = true;
            }
            return this.memory[method](key);
        }
    }

    increment(key) { return this._shared('increment', key); }
    decrement(key) { return this._shared('decrement', key); }
    resetKey(key) { return this._shared('resetKey', key); }
}

// Sign-in and OTP requests count per account (email or phone) on each network
// address. Many people can share one address: mobile networks put thousands
// behind one, and a hospital's staff share its Wi-Fi.
const accountKey = (req) => {
    const account = String(req.body?.email || req.body?.phone || req.body?.phoneNumber || '').trim().toLowerCase();
    return account ? `${req.ip}:${account}` : req.ip;
};

// Signed-in requests count per user
const userKey = (req) => {
    const userId = req.user?._id || req.user?.id;
    return userId ? `u:${userId}` : req.ip;
};

const createRateLimit = (name, windowMs, max, message, keyGenerator = (req) => req.ip) => {
    return rateLimit({
        windowMs,
        max,
        message: { success: false, message },
        standardHeaders: true,
        legacyHeaders: false,
        store: new SharedStore(name),
        keyGenerator,
        handler: async (req, res) => {
            // Log rate limit violations to cache
            await cacheService.set(`rate_limit:${req.ip}`, {
                ip: req.ip,
                endpoint: req.path,
                method: req.method,
                timestamp: new Date().toISOString()
            }, 900); // 15 minutes

            res.status(429).json({
                success: false,
                message: 'Too many requests. Please try again later.'
            });
        }
    });
};

// One network address can't try more than this many sign-ins or codes across
// all accounts
const authAddressCeiling = createRateLimit(
    'auth-ip',
    15 * 60 * 1000,
    100,
    'Too many authentication attempts. Please try again later.'
);

// Different rate limits for different endpoints
exports.authRateLimit = [
    authAddressCeiling,
    createRateLimit(
        'auth',
        15 * 60 * 1000, // 15 minutes
        5, // 5 attempts per account per 15 minutes
        'Too many authentication attempts. Please try again later.',
        accountKey
    )
];

exports.otpRateLimit = [
    authAddressCeiling,
    createRateLimit(
        'otp',
        15 * 60 * 1000, // 15 minute
        3, // 3 OTP requests per account per 15 minute
        'Too many OTP requests. Please wait before requesting another.',
        accountKey
    )
];

exports.signupRateLimit = createRateLimit(
    'signup',
    60 * 60 * 1000, // 1 hour
    3, // 3 signup attempts per account per hour
    'Too many signup attempts. Please try again later.',
    accountKey
);

exports.generalRateLimit = createRateLimit(
    'general',
    15 * 60 * 1000, // 15 minutes
    100, // 100 requests per 15 minutes
    'Too many requests. Please slow down.'
);

exports.locationPermissionRateLimit = createRateLimit(
    'location-permission',
    15 * 60 * 1000, // 15 minutes
    5, // 5 requests per 15 minutes
    'Too many location permission requests. Please try again later.',
    userKey
);


// Staff availability rate limit
exports.staffAvailabilityRateLimit = createRateLimit(
    'availability',
    60 * 1000, // 1 minute
    5, // 5 availability toggles per minute
    'Too many availability changes. Please try again later.',
    userKey
);

// Phone OTP — 3 requests per 15 minutes (same window as email OTP)
exports.phoneOtpRateLimit = createRateLimit(
    'phone-otp',
    15 * 60 * 1000,
    3,
    'Too many phone OTP requests. Please wait before requesting another.',
    userKey
);

// Verify Phone OTP — separate limiter, 3 attempts per 15 minutes.
exports.verifyPhoneOtpRateLimit = createRateLimit(
    'verify-phone-otp',
    15 * 60 * 1000,
    3,
    'Too many OTP verification attempts. Please request a new OTP and try again later.',
    userKey
);
// Address search and pin lookups — per signed-in user, so people behind one
// network don't share a limit. Use after protect.
exports.mapsRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SharedStore('maps'),
    keyGenerator: (req) => `maps:${req.user?._id || req.user?.id}`,
    handler: (req, res) => res.status(429).json({
        success: false,
        message: 'Too many map searches. Please wait a moment and try again.'
    })
});

exports.SharedStore = SharedStore;
exports.accountKey = accountKey;
exports.userKey = userKey;
