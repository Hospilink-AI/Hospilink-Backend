const util = require('util');
const pino = require('pino');

// LOG_LEVEL: 'debug' | 'info' (default) | 'warn' | 'error'.
// One JSON line per entry ({"level","time","msg", ...fields}), so CloudWatch
// Logs Insights can filter on fields. Writes are buffered and made off the
// request path; console.log is a blocking write to the container's stdout.
// Pending lines are flushed when the process exits.
const LEVELS = ['debug', 'info', 'warn', 'error'];
const level = (process.env.LOG_LEVEL || 'info').toLowerCase();

const isPlainObject = (value) => value !== null && typeof value === 'object'
    && !Array.isArray(value) && !(value instanceof Error);

const asText = (value) => (typeof value === 'string' ? value : util.inspect(value));

function build(destination) {
    const base = pino(
        {
            level: LEVELS.includes(level) ? level : 'info',
            base: null,
            timestamp: pino.stdTimeFunctions.isoTime,
            formatters: {
                level: (label) => ({ level: label })
            },
            // Only these error fields: HTTP client errors also carry the
            // request, with API keys in its headers and URL
            serializers: {
                err: (err) => ({
                    type: err.name,
                    message: err.message,
                    code: err.code,
                    status: err.status || err.statusCode || err.response?.status,
                    stack: err.stack
                })
            }
        },
        destination
    );

    /**
     * Same calls as before: logger.info('text'), logger.error('text:', err),
     * logger.warn('text', { ip }). A plain object becomes fields on the line,
     * an Error becomes `err` with its stack, anything else joins the text.
     */
    const write = (method) => (message, ...args) => {
        if (!base.isLevelEnabled(method)) return;
        let fields = null;
        let error = null;
        const rest = [];
        for (const arg of args) {
            if (arg instanceof Error && !error) error = arg;
            else if (isPlainObject(arg) && !fields) fields = arg;
            else rest.push(arg);
        }
        const text = rest.length ? util.format(asText(message), ...rest) : asText(message);
        const extra = { ...(fields || {}) };
        if (error) extra.err = error;
        if (Object.keys(extra).length) base[method](extra, text);
        else base[method](text);
    };

    return {
        debug: write('debug'),
        info: write('info'),
        warn: write('warn'),
        error: write('error'),
        // Write out anything still buffered
        flush: () => new Promise((resolve) => base.flush(() => resolve())),
        // Morgan writes access lines here instead of to stdout directly
        stream: { write: (line) => base.info(line.trimEnd()) }
    };
}

const logger = build(pino.destination({ dest: 1, sync: process.env.NODE_ENV === 'test' }));
// For tests: the same logger writing somewhere else
logger.build = build;

/**
 * Send console.log / info / warn / error / debug through the logger too, so
 * the many older console calls are also JSON lines written off the request
 * path (and errors are trimmed the same way). Called once at start-up; not in
 * tests, which keep the normal console.
 */
logger.captureConsole = (target = console) => {
    target.log = (...args) => logger.info(...args);
    target.info = (...args) => logger.info(...args);
    target.warn = (...args) => logger.warn(...args);
    target.error = (...args) => logger.error(...args);
    target.debug = (...args) => logger.debug(...args);
};

module.exports = logger;
