// Logs are JSON lines written off the request path, keep the extra
// arguments the old logger dropped, and never write API keys from errors
const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');

function capture() {
    const lines = [];
    const log = logger.build({ write: (line) => lines.push(JSON.parse(line)) });
    return { log, lines };
}

test('one JSON line with level, time and message', () => {
    const { log, lines } = capture();
    log.info('Server running on port 3000');
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'Server running on port 3000' });
    expect(new Date(lines[0].time).toString()).not.toBe('Invalid Date');
});

test('keeps the arguments the old logger dropped', () => {
    const { log, lines } = capture();
    log.error('Failed to initialize Redis adapter:', 'ECONNREFUSED');
    log.warn('Webhook rejected: invalid or missing token', { ip: '10.0.0.1' });
    expect(lines[0].msg).toBe('Failed to initialize Redis adapter: ECONNREFUSED');
    expect(lines[1]).toMatchObject({ msg: 'Webhook rejected: invalid or missing token', ip: '10.0.0.1' });
});

test('an error keeps its message and stack but not the request it came from', () => {
    const { log, lines } = capture();
    const err = new Error('Request failed with status code 401');
    err.config = { headers: { 'api-key': 'SECRET-KEY' }, url: 'https://maps.example/json?key=SECRET-KEY' };
    err.response = { status: 401, data: { echoed: 'SECRET-KEY' } };
    log.error('IDfy call failed:', err);
    expect(lines[0].err).toMatchObject({ type: 'Error', message: 'Request failed with status code 401', status: 401 });
    expect(lines[0].err.stack).toContain('Error: Request failed');
    expect(JSON.stringify(lines[0])).not.toContain('SECRET-KEY');
});

test('debug lines are skipped at the default level', () => {
    const { log, lines } = capture();
    log.debug('feed step');
    expect(lines).toHaveLength(0);
});

test('access log lines go through the logger, without query strings', () => {
    const { log, lines } = capture();
    log.stream.write('10.0.0.1 - - "POST /api/webhook/idfy-aadhaar HTTP/1.1" 200\n');
    expect(lines[0].msg).toBe('10.0.0.1 - - "POST /api/webhook/idfy-aadhaar HTTP/1.1" 200');
    const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
    expect(app).toContain('morgan.token("path-only"');
    expect(app).toContain('stream: logger.stream');
    expect(app).not.toMatch(/morgan\("combined"/);
});

test('console calls can be sent through the logger', () => {
    const calls = [];
    const fake = {};
    const original = { info: logger.info, error: logger.error };
    logger.info = (...args) => calls.push(['info', ...args]);
    logger.error = (...args) => calls.push(['error', ...args]);
    try {
        logger.captureConsole(fake);
        fake.log('Cron jobs scheduled');
        fake.error('IDFY error:', 'timeout');
    } finally {
        Object.assign(logger, original);
    }
    expect(calls).toEqual([['info', 'Cron jobs scheduled'], ['error', 'IDFY error:', 'timeout']]);
    const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
    expect(app).toContain('if (process.env.NODE_ENV !== "test") logger.captureConsole();');
});
