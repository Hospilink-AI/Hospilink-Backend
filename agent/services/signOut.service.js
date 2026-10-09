const Redis = require('ioredis');
const logger = require('../utils/logger');

/**
 * Has this token been signed out? The backend writes `blacklist:<token>` to
 * its Redis on sign-out (key prefix `hospilink:`). The agent reads the same
 * key, so a signed-out token stops working here too.
 *
 * Uses the backend's Redis settings (REDIS_HOST, REDIS_PORT, REDIS_PASSWORD,
 * REDIS_USERNAME, REDIS_DB, REDIS_TLS). Without REDIS_HOST the check is
 * skipped, with a warning at start-up. When it is set and Redis can't be
 * read, sign-in fails, like the backend.
 */
let client = null;

function configured() {
    return Boolean(process.env.REDIS_HOST);
}

function getClient() {
    if (!client) {
        client = new Redis({
            host: process.env.REDIS_HOST,
            port: parseInt(process.env.REDIS_PORT, 10) || 6379,
            password: process.env.REDIS_PASSWORD || undefined,
            username: process.env.REDIS_USERNAME || 'default',
            db: parseInt(process.env.REDIS_DB, 10) || 0,
            keyPrefix: 'hospilink:',
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            connectTimeout: 3000,
            commandTimeout: 1000,
            ...(process.env.REDIS_TLS === 'true' ? { tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } } : {})
        });
        client.on('error', (err) => logger.warn('Agent Redis error', { error: err.message }));
    }
    return client;
}

if (!configured()) {
    logger.warn('REDIS_HOST is not set: the agent cannot see sign-outs, so a signed-out token keeps working until it expires');
}

/**
 * @returns {Promise<boolean>} true when the token was signed out
 * @throws when Redis is configured but can't be read
 */
async function isSignedOut(token) {
    if (!configured()) return false;
    const value = await getClient().get(`blacklist:${token}`);
    return Boolean(value && JSON.parse(value));
}

async function close() {
    if (client) await client.quit().catch(() => {});
    client = null;
}

module.exports = { isSignedOut, configured, close };
