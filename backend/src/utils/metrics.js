const { monitorEventLoopDelay } = require('perf_hooks');
const logger = require('./logger');

/**
 * Service metrics for CloudWatch, with no agent or SDK.
 *
 * Once a minute each server task writes one log line in CloudWatch's
 * Embedded Metric Format (EMF). CloudWatch Logs turns it into metrics under
 * the namespace METRICS_NAMESPACE (default "HospiLink"), dimension
 * Service=backend, so dashboards and alarms can be built on them:
 *
 *   Requests, ServerErrors (5xx), ClientErrors (4xx)
 *   LatencyP50, LatencyP95, LatencyP99, LatencyMax (ms)
 *   EventLoopDelayP99 (ms), HeapUsedMB, Sockets
 *   CronJobFailures (also logged per job with its name)
 *
 * METRICS_ENABLED=false turns it off. It is off in tests.
 */

const NAMESPACE = process.env.METRICS_NAMESPACE || 'HospiLink';
const FLUSH_MS = 60 * 1000;
const MAX_SAMPLES = 5000; // latency samples kept per minute

let window = freshWindow();
let loopDelay = null;
let timer = null;
let socketCount = () => 0;

function freshWindow() {
    return { requests: 0, serverErrors: 0, clientErrors: 0, durations: [], cronFailures: 0 };
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)];
}

function recordRequest(statusCode, durationMs) {
    window.requests++;
    if (statusCode >= 500) window.serverErrors++;
    else if (statusCode >= 400) window.clientErrors++;
    if (window.durations.length < MAX_SAMPLES) {
        window.durations.push(durationMs);
    } else {
        // Keep a fair sample once full (reservoir sampling)
        const slot = Math.floor(Math.random() * window.requests);
        if (slot < MAX_SAMPLES) window.durations[slot] = durationMs;
    }
}

// Express middleware: one sample per finished request (health checks left out)
function requestMetrics(req, res, next) {
    if (req.path === '/health') return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        recordRequest(res.statusCode, Number(process.hrtime.bigint() - start) / 1e6);
    });
    next();
}

// A scheduled job failed: counted and logged with its name
function cronJobFailed(jobName, error) {
    window.cronFailures++;
    logger.error(`Cron job failed: ${jobName}`, error instanceof Error ? error : new Error(String(error)), { cronJob: jobName });
}

function snapshot() {
    const sorted = window.durations.slice().sort((a, b) => a - b);
    const round = (n) => Math.round(n * 10) / 10;
    const values = {
        Requests: window.requests,
        ServerErrors: window.serverErrors,
        ClientErrors: window.clientErrors,
        LatencyP50: round(percentile(sorted, 50)),
        LatencyP95: round(percentile(sorted, 95)),
        LatencyP99: round(percentile(sorted, 99)),
        LatencyMax: round(sorted.length ? sorted[sorted.length - 1] : 0),
        EventLoopDelayP99: loopDelay ? round(loopDelay.percentile(99) / 1e6) : 0,
        HeapUsedMB: round(process.memoryUsage().heapUsed / 1024 / 1024),
        Sockets: socketCount(),
        CronJobFailures: window.cronFailures
    };
    return values;
}

// The EMF line for one minute
function emf(values, timestamp = Date.now()) {
    const units = {
        Requests: 'Count', ServerErrors: 'Count', ClientErrors: 'Count',
        LatencyP50: 'Milliseconds', LatencyP95: 'Milliseconds', LatencyP99: 'Milliseconds', LatencyMax: 'Milliseconds',
        EventLoopDelayP99: 'Milliseconds', HeapUsedMB: 'Megabytes', Sockets: 'Count', CronJobFailures: 'Count'
    };
    return {
        _aws: {
            Timestamp: timestamp,
            CloudWatchMetrics: [{
                Namespace: NAMESPACE,
                Dimensions: [['Service']],
                Metrics: Object.keys(values).map(name => ({ Name: name, Unit: units[name] }))
            }]
        },
        Service: 'backend',
        ...values
    };
}

function flush() {
    const values = snapshot();
    window = freshWindow();
    if (loopDelay) loopDelay.reset();
    logger.info('metrics', emf(values));
    return values;
}

function start({ sockets } = {}) {
    if (process.env.METRICS_ENABLED === 'false' || process.env.NODE_ENV === 'test') return false;
    if (timer) return true;
    if (typeof sockets === 'function') socketCount = sockets;
    loopDelay = monitorEventLoopDelay({ resolution: 20 });
    loopDelay.enable();
    timer = setInterval(flush, FLUSH_MS);
    timer.unref();
    return true;
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (loopDelay) loopDelay.disable();
}

module.exports = {
    requestMetrics,
    recordRequest,
    cronJobFailed,
    snapshot,
    emf,
    flush,
    start,
    stop,
    _reset: () => { window = freshWindow(); }
};
