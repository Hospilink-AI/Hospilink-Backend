// Request data can't smuggle MongoDB operators, admin filters can't run
// arbitrary patterns, and missing production settings are reported
const fs = require('fs');
const path = require('path');
const { stripOperators } = require('../src/middleware/stripOperators.middleware');
const escapeRegex = require('../src/utils/escapeRegex');
const { startupWarnings } = require('../src/config/startupChecks');

function run(req) {
    let called = false;
    stripOperators(req, {}, () => { called = true; });
    return called;
}

describe('operators in request data', () => {
    it('removes $ keys at any depth, in the body, query and params', () => {
        const req = {
            body: { email: { $ne: null }, password: 'x', nested: [{ $where: 'sleep(1)', ok: 1 }] },
            query: { status: { $gt: '' }, page: '2' },
            params: { id: 'abc' }
        };
        expect(run(req)).toBe(true);
        expect(req.body).toEqual({ email: {}, password: 'x', nested: [{ ok: 1 }] });
        expect(req.query).toEqual({ status: {}, page: '2' });
        expect(req.strippedOperators).toBe(3);
    });

    it('leaves ordinary data, including dotted setting keys, alone', () => {
        const req = { body: { 'offer.initialRadiusKm': 30, note: 'costs $5' }, query: {}, params: {} };
        run(req);
        expect(req.body).toEqual({ 'offer.initialRadiusKm': 30, note: 'costs $5' });
        expect(req.strippedOperators).toBeUndefined();
    });

    it('runs for every request, right after the body is read', () => {
        const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
        const parsed = app.indexOf('app.use(express.urlencoded(');
        const stripped = app.indexOf('stripOperators.middleware").stripOperators');
        expect(stripped).toBeGreaterThan(parsed);
        expect(stripped).toBeLessThan(app.indexOf('app.use("/api/auth"'));
    });
});

describe('patterns in admin filters', () => {
    it('match the text literally', () => {
        expect(new RegExp(escapeRegex('(a+)+$')).test('(a+)+$')).toBe(true);
        expect(new RegExp(`^${escapeRegex('r.o')}$`).test('rmo')).toBe(false);
    });

    it('are escaped where admins can type them', () => {
        const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        expect(read('src/models/ActivityLog.js')).not.toContain('new RegExp(filters.location');
        expect(read('src/utils/activityLog.helpers.js')).not.toContain('new RegExp(filters.location');
        expect(read('src/services/admin/staff.js')).toContain('new RegExp(`^${escapeRegex(r.trim())}$`');
    });
});

describe('production settings', () => {
    it('warns about missing ones in production only', () => {
        expect(startupWarnings({ NODE_ENV: 'development' })).toEqual([]);
        const warnings = startupWarnings({ NODE_ENV: 'production' });
        expect(warnings.join(' ')).toMatch(/CORS_ORIGINS[\s\S]*JWT_EXPIRES_IN[\s\S]*IDFY_WEBHOOK_TOKEN/);
        expect(startupWarnings({ NODE_ENV: 'production', CORS_ORIGINS: 'https://hospilink.in', JWT_EXPIRES_IN: '7d', IDFY_WEBHOOK_TOKEN: 't' })).toEqual([]);
    });
});
