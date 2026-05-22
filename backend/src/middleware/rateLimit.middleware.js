const rateLimit = require('express-rate-limit');
const cacheService = require('../services/cache.service');


const createRateLimit = (windowMs, max, message) => {
    return rateLimit({
        windowMs,
        max,
        message: { success: false, message },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => req.ip,
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

// Different rate limits for different endpoints
exports.authRateLimit = createRateLimit(
    15 * 60 * 1000, // 15 minutes
    5, // 5 attempts per 15 minutes
    'Too many authentication attempts. Please try again later.'
);

exports.otpRateLimit = createRateLimit(
    15 * 60 * 1000, // 15 minute
    3, // 3 OTP requests per 15 minute
    'Too many OTP requests. Please wait before requesting another.'
);

exports.signupRateLimit = createRateLimit(
    60 * 60 * 1000, // 1 hour
    3, // 3 signup attempts per hour
    'Too many signup attempts. Please try again later.'
);

exports.generalRateLimit = createRateLimit(
    15 * 60 * 1000, // 15 minutes
    100, // 100 requests per 15 minutes
    'Too many requests. Please slow down.'
);

exports.locationPermissionRateLimit = createRateLimit(
    15 * 60 * 1000, // 15 minutes
    5, // 5 requests per 15 minutes
    'Too many location permission requests. Please try again later.'
);


// Staff availability rate limit
exports.staffAvailabilityRateLimit = createRateLimit(
    60 * 1000, // 1 minute
    5, // 5 availability toggles per minute
    'Too many availability changes. Please try again later.'
);