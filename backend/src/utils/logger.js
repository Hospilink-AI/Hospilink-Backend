// LOG_LEVEL: 'debug' | 'info' (default) | 'warn' | 'error'. Every log line
// is a synchronous write to stdout in the container, so chatty logs cost
// request time; debug lines are only written when asked for.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

const logger = {
    debug: (message) => {
        if (threshold <= LEVELS.debug) console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`);
    },
    info: (message) => {
        if (threshold > LEVELS.info) return;
        console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
    },
    error: (message) => {
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`);
    },
    warn: (message) => {
        if (threshold > LEVELS.warn) return;
        console.warn(`[WARN] ${new Date().toISOString()} - ${message}`);
    }
};

module.exports = logger;