// Rate limits count in Redis, so every server task shares one count, and
// they never fail a request when Redis is down

const mockKeys = new Map();
let mockRedisDown = false;

// Enough of Redis to run the rate-limit-redis scripts
jest.mock('../src/config/redis', () => ({
    getClientAsync: async () => {
        if (mockRedisDown) throw new Error('redis down');
        return {
            call: async (command, ...args) => {
                if (command === 'SCRIPT') return args[1].includes('INCR') ? 'sha-incr' : 'sha-get';
                if (command === 'EVALSHA') {
                    const [sha, , key, , windowMs] = args;
                    const now = Date.now();
                    const entry = mockKeys.get(key);
                    if (sha === 'sha-get') return entry ? [entry.hits, entry.expires - now] : [false, -2];
                    if (!entry || entry.expires <= now) {
                        mockKeys.set(key, { hits: 1, expires: now + Number(windowMs) });
                        return [1, Number(windowMs)];
                    }
                    entry.hits += 1;
                    return [entry.hits, entry.expires - now];
                }
                if (command === 'DEL') { mockKeys.delete(args[0]); return 1; }
                if (command === 'DECR') { const e = mockKeys.get(args[0]); if (e) e.hits -= 1; return e ? e.hits : 0; }
                throw new Error(`unexpected ${command}`);
            }
        };
    }
}));
jest.mock('../src/services/cache.service', () => ({ set: async () => true }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const rateLimit = require('express-rate-limit');
const { SharedStore, accountKey, userKey } = require('../src/middleware/rateLimit.middleware');

function limiter(max, keyGenerator = (req) => req.ip) {
    return rateLimit({ windowMs: 60000, max, store: new SharedStore('test'), keyGenerator, standardHeaders: false, legacyHeaders: false });
}

function hit(middleware, req = {}) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200,
            headers: {},
            setHeader() {},
            status(code) { this.statusCode = code; return this; },
            send() { resolve(this.statusCode); return this; },
            json() { resolve(this.statusCode); return this; },
            end() { resolve(this.statusCode); }
        };
        middleware({ ip: '1.2.3.4', headers: {}, app: { get: () => false }, ...req }, res, () => resolve('passed'));
    });
}

beforeEach(() => {
    mockKeys.clear();
    mockRedisDown = false;
});

test('two server tasks share one count', async () => {
    const taskA = limiter(3);
    const taskB = limiter(3);
    expect(await hit(taskA)).toBe('passed');
    expect(await hit(taskB)).toBe('passed');
    expect(await hit(taskA)).toBe('passed');
    expect(await hit(taskB)).toBe(429);
});

test('Redis down: the request still goes through, counted on this task', async () => {
    mockRedisDown = true;
    const task = limiter(2);
    expect(await hit(task)).toBe('passed');
    expect(await hit(task)).toBe('passed');
    expect(await hit(task)).toBe(429);
});

test('each limiter has its own keys', async () => {
    const a = new SharedStore('auth');
    const b = new SharedStore('otp');
    a.init({ windowMs: 60000 });
    b.init({ windowMs: 60000 });
    await a.increment('1.2.3.4');
    await b.increment('1.2.3.4');
    expect([...mockKeys.keys()].sort()).toEqual(['rl:auth:1.2.3.4', 'rl:otp:1.2.3.4']);
});

test('sign-in counts per account on each address, so a shared network is not locked out', async () => {
    const signIn = limiter(1, accountKey);
    expect(await hit(signIn, { body: { email: 'a@test.in' } })).toBe('passed');
    expect(await hit(signIn, { body: { email: 'B@test.in' } })).toBe('passed');
    expect(await hit(signIn, { body: { email: 'A@test.in ' } })).toBe(429);
});

test('signed-in limits count per user', async () => {
    const toggle = limiter(1, userKey);
    expect(await hit(toggle, { user: { _id: 'u1' } })).toBe('passed');
    expect(await hit(toggle, { user: { _id: 'u2' } })).toBe('passed');
    expect(await hit(toggle, { user: { _id: 'u1' } })).toBe(429);
});

test('loading the middleware does not touch Redis', () => {
    jest.isolateModules(() => {
        mockRedisDown = true;
        expect(() => require('../src/middleware/rateLimit.middleware')).not.toThrow();
    });
});

test('sign-in routes keep the per-address ceiling in front of the per-account limit', () => {
    const { authRateLimit, otpRateLimit } = require('../src/middleware/rateLimit.middleware');
    expect(Array.isArray(authRateLimit)).toBe(true);
    expect(authRateLimit).toHaveLength(2);
    expect(otpRateLimit[0]).toBe(authRateLimit[0]);
});
