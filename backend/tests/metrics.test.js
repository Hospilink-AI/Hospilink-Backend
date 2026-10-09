// Per-minute service metrics in CloudWatch's Embedded Metric Format
const mockLines = [];
jest.mock('../src/utils/logger', () => ({
    info: (msg, fields) => mockLines.push({ msg, fields }),
    error: (msg, err, fields) => mockLines.push({ msg, err, fields }),
    warn: jest.fn(),
    debug: jest.fn()
}));

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const metrics = require('../src/utils/metrics');

beforeEach(() => {
    mockLines.length = 0;
    metrics._reset();
});

test('counts requests and errors, with latency percentiles', () => {
    for (let ms = 1; ms <= 100; ms++) metrics.recordRequest(200, ms);
    metrics.recordRequest(404, 5);
    metrics.recordRequest(500, 900);
    const values = metrics.snapshot();
    expect(values).toMatchObject({ Requests: 102, ServerErrors: 1, ClientErrors: 1, LatencyMax: 900 });
    expect(values.LatencyP50).toBeGreaterThanOrEqual(49);
    expect(values.LatencyP50).toBeLessThanOrEqual(52);
    expect(values.LatencyP99).toBeGreaterThanOrEqual(99);
});

test('the middleware times each request and skips health checks', () => {
    const run = (p, status) => {
        const res = new EventEmitter();
        res.statusCode = status;
        metrics.requestMetrics({ path: p }, res, () => {});
        res.emit('finish');
    };
    run('/api/duties/available', 200);
    run('/health', 200);
    run('/api/profile/me', 503);
    expect(metrics.snapshot()).toMatchObject({ Requests: 2, ServerErrors: 1 });
});

test('a failed cron job is counted and logged with its name', () => {
    metrics.cronJobFailed('Ticket SLA sweeps job', new Error('validation failed'));
    expect(metrics.snapshot().CronJobFailures).toBe(1);
    expect(mockLines[0]).toMatchObject({ msg: 'Cron job failed: Ticket SLA sweeps job', fields: { cronJob: 'Ticket SLA sweeps job' } });
});

test('flush writes one EMF line and starts a new minute', () => {
    metrics.recordRequest(200, 12);
    const values = metrics.flush();
    expect(values.Requests).toBe(1);
    const line = mockLines.find(l => l.msg === 'metrics').fields;
    expect(line.Service).toBe('backend');
    expect(line.Requests).toBe(1);
    const definition = line._aws.CloudWatchMetrics[0];
    expect(definition.Namespace).toBe('HospiLink');
    expect(definition.Dimensions).toEqual([['Service']]);
    expect(definition.Metrics.map(m => m.Name)).toEqual(expect.arrayContaining(['Requests', 'LatencyP99', 'CronJobFailures', 'EventLoopDelayP99']));
    expect(typeof line._aws.Timestamp).toBe('number');
    expect(metrics.snapshot().Requests).toBe(0);
});

test('stays off in tests, and is wired into the app, the server and every cron job', () => {
    expect(metrics.start()).toBe(false);
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    expect(read('src/app.js')).toContain('require("./utils/metrics").requestMetrics');
    expect(read('server.js')).toContain("require('./src/utils/metrics').start(");
    const cron = read('src/utils/cronJobs.js');
    expect(cron.match(/metrics\.cronJobFailed\(/g).length).toBe(10);
    expect(cron).not.toMatch(/console\.error\('[^']*(job failed|rollup failed|snapshot failed)/);
});
