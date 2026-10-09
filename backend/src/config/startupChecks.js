const logger = require('../utils/logger');

// Settings that are optional in development but unsafe to leave out in
// production. Warned about at start-up; nothing is changed.
function startupWarnings(env = process.env) {
    if (env.NODE_ENV !== 'production') return [];
    const warnings = [];
    if (!String(env.CORS_ORIGINS || '').trim()) {
        warnings.push('CORS_ORIGINS is not set: every website can call the API with a signed-in user\'s token');
    }
    if (!String(env.JWT_EXPIRES_IN || '').trim()) {
        warnings.push('JWT_EXPIRES_IN is not set: sign-in tokens never expire');
    }
    if (!String(env.IDFY_WEBHOOK_TOKEN || '').trim()) {
        warnings.push('IDFY_WEBHOOK_TOKEN is not set: Aadhaar results from DigiLocker are refused');
    }
    return warnings;
}

function warnAtStartup() {
    for (const warning of startupWarnings()) logger.warn(`Config: ${warning}`);
}

module.exports = { startupWarnings, warnAtStartup };
