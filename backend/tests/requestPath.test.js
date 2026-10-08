// The per-request path: one Redis round trip for sign-in checks, gzip for
// large responses, and debug logs only when asked for.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockRedis = { calls: [], values: {} , fail: false };
jest.mock('../src/services/cache.service', () => ({
    getManyStrict: async (keys) => {
        mockRedis.calls.push(keys);
        if (mockRedis.fail) throw new Error('redis down');
        return keys.map(k => mockRedis.values[k] ?? null);
    },
    getStrict: async () => { throw new Error('should not be called'); },
    get: async () => { throw new Error('should not be called'); },
    set: async () => true
}));

const jwt = require('jsonwebtoken');
const User = require('../src/models/User');
const { protect } = require('../src/middleware/auth.middleware');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

function run(token) {
    return new Promise((resolve) => {
        const req = { headers: { authorization: `Bearer ${token}` } };
        protect(req, {}, (err) => resolve({ err, req }));
    });
}

beforeEach(() => {
    mockRedis.calls.length = 0;
    mockRedis.values = {};
    mockRedis.fail = false;
});

describe('sign-in check on each request', () => {
    const token = jwt.sign({ id: 'u1' }, process.env.JWT_SECRET);

    it('reads the blacklist and the session together, once', async () => {
        mockRedis.values['session:u1'] = { _id: 'u1', id: 'u1', role: 'staff' };
        const { err, req } = await run(token);
        expect(err).toBeUndefined();
        expect(mockRedis.calls).toEqual([[`blacklist:${token}`, 'session:u1']]);
        expect(req.user.role).toBe('staff');
    });

    it('refuses a blacklisted token', async () => {
        mockRedis.values[`blacklist:${token}`] = true;
        mockRedis.values['session:u1'] = { _id: 'u1', role: 'staff' };
        const { err } = await run(token);
        expect(err.message).toMatch(/invalidated/);
    });

    it('stays closed when Redis is down', async () => {
        mockRedis.fail = true;
        const { err } = await run(token);
        expect(err.message).toMatch(/unavailable/);
    });

    it('never touches Redis for a forged token', async () => {
        const { err } = await run(jwt.sign({ id: 'u1' }, 'wrong-secret'));
        expect(err.message).toBe('Invalid token');
        expect(mockRedis.calls).toHaveLength(0);
    });

    it('falls back to the database without a cached session', async () => {
        User.findById = async () => ({ _id: 'u1', role: 'hospital', isActive: true });
        const { err, req } = await run(token);
        expect(err).toBeUndefined();
        expect(req.user.role).toBe('hospital');
    });
});

describe('app setup', () => {
    const fs = require('fs');
    const path = require('path');
    const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

    it('compresses responses over 1 KB and skips health checks in the access log', () => {
        expect(app).toContain('app.use(compression({ threshold: 1024 }));');
        expect(app).toContain('skip: (req) => req.path === "/health"');
    });

    it('sizes the MongoDB pool', () => {
        const db = fs.readFileSync(path.join(__dirname, '../src/config/database.js'), 'utf8');
        expect(db).toMatch(/maxPoolSize: .*\|\| 100/);
        expect(db).toMatch(/minPoolSize: .*\|\| 10/);
    });

    it('logs no doctor coordinates when a duty is opened', () => {
        const duty = fs.readFileSync(path.join(__dirname, '../src/services/duty.service.js'), 'utf8');
        expect(duty).not.toMatch(/console\.log\(`Staff accessing duty/);
    });
});

describe('log levels', () => {
    it('writes debug lines only when LOG_LEVEL asks for them', () => {
        const real = jest.requireActual('../src/utils/logger');
        const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
        real.debug('hidden');
        expect(spy).not.toHaveBeenCalled();
        real.info('shown');
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});

describe('profile cache', () => {
    it('lives shorter than the signed links it holds', () => {
        const fs = require('fs');
        const path = require('path');
        const profile = fs.readFileSync(path.join(__dirname, '../src/services/profile.service.js'), 'utf8');
        const s3 = fs.readFileSync(path.join(__dirname, '../src/services/s3.service.js'), 'utf8');
        const linkSeconds = Number(s3.match(/expiresIn: (\d+)/)[1]);
        const cacheSeconds = Number(profile.match(/setProfile\(userId, user\.role, result, (\d+)\)/)[1]);
        expect(linkSeconds - cacheSeconds).toBeGreaterThanOrEqual(300);
    });
});
