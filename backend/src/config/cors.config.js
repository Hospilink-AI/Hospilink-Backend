/**
 * Shared CORS configuration for backend (REST API + Socket.IO)
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
            // Allow server-to-server requests (no Origin header)
            if (!origin) return callback(null, true);
            // Allow all if no whitelist configured (local dev)
            if (!allowed) return callback(null, true);
            if (allowed.includes(origin)) return callback(null, true);
            callback(new Error(`CORS: origin ${origin} not allowed`));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'Accept',
            'X-Requested-With',
            'Origin',
            'Access-Control-Request-Method',
            'Access-Control-Request-Headers',
            'Cache-Control',
        ],
        exposedHeaders: ['Content-Length', 'X-Request-ID'],
        maxAge: 86400,
        optionsSuccessStatus: 200,
        ...extraOptions,
    };
}

// Socket.IO needs the origin as a plain array or function — same logic, different shape
function buildSocketCorsOptions() {
    const allowed = getAllowedOrigins();
    return {
        origin: allowed || '*',
        credentials: true,
        methods: ['GET', 'POST'],
    };
}

module.exports = { buildCorsOptions, buildSocketCorsOptions };
