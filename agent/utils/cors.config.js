/**
 * Shared CORS configuration for agent service
 *
 * Set CORS_ORIGINS in .env as a comma-separated list:
 *   CORS_ORIGINS=https://hospilink.in,https://hospilink-frontend-ten.vercel.app
 *
 * In development, if CORS_ORIGINS is not set, all origins are allowed.
 */

function getAllowedOrigins() {
    const raw = process.env.CORS_ORIGINS || '';
    if (!raw.trim()) return null; // null = allow all (dev fallback)
    return raw.split(',').map(o => o.trim()).filter(Boolean);
}

function buildCorsOptions(extraOptions = {}) {
    const allowed = getAllowedOrigins();

    return {
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (!allowed) return callback(null, true);
            if (allowed.includes(origin)) return callback(null, true);
            callback(new Error(`CORS: origin ${origin} not allowed`));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
        maxAge: 86400,
        ...extraOptions,
    };
}

// Returns the raw origin value for manual header setting (Vercel serverless handler)
function getAllowedOriginsRaw() {
    return getAllowedOrigins();
}

module.exports = { buildCorsOptions, getAllowedOriginsRaw };
