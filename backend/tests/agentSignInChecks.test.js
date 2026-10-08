// The agent follows the backend's sign-in rules: signed-out tokens, accounts
// scheduled for deletion and deactivated admins are refused, and its internal
// pages need a Super Admin
const mockSignOut = { signedOut: false, down: false };
jest.mock('../../agent/services/signOut.service', () => ({
    isSignedOut: async () => {
        if (mockSignOut.down) throw new Error('redis down');
        return mockSignOut.signedOut;
    },
    configured: () => true
}));

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const User = require('../../agent/models/User');
const { protect, accountRefusal } = require('../../agent/middleware/auth.middleware');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

let user;
let selected;

beforeEach(() => {
    mockSignOut.signedOut = false;
    mockSignOut.down = false;
    user = { _id: 'u1', role: 'staff', name: 'TEST' };
    User.findById = () => {
        const c = { select: (f) => { selected = f; return c; }, lean: async () => user };
        return c;
    };
});

function call() {
    const token = jwt.sign({ id: 'u1' }, process.env.JWT_SECRET);
    return new Promise((resolve) => {
        const res = {
            code: 200,
            status(s) { this.code = s; return this; },
            json(body) { resolve({ status: this.code, body, req }); return this; }
        };
        const req = { headers: { authorization: `Bearer ${token}` }, ip: '10.0.0.1', get: () => '' };
        protect(req, res, () => resolve({ status: 'next', req }));
    });
}

test('a signed-in doctor gets through with a plain user object', async () => {
    const { status, req } = await call();
    expect(status).toBe('next');
    expect(req.user.role).toBe('staff');
    expect(selected).toContain('deletion');
});

test('a token signed out on the backend is refused', async () => {
    mockSignOut.signedOut = true;
    const { status, body } = await call();
    expect(status).toBe(401);
    expect(body.code).toBe('TOKEN_INVALIDATED');
});

test('if the sign-out list cannot be read, sign-in fails instead of skipping the check', async () => {
    mockSignOut.down = true;
    const { status, body } = await call();
    expect(status).toBe(503);
    expect(body.code).toBe('AUTH_UNAVAILABLE');
});

test('an account scheduled for deletion is refused', async () => {
    user.deletion = { requestedAt: new Date() };
    const { status, body } = await call();
    expect(status).toBe(403);
    expect(body.code).toBe('ACCOUNT_SCHEDULED_FOR_DELETION');
});

test('deleted accounts and deactivated admins are refused', () => {
    expect(accountRefusal({ deletion: { completedAt: new Date() } }).status).toBe(401);
    expect(accountRefusal({ role: 'admin', isActive: false }).code).toBe('ACCOUNT_DEACTIVATED');
    expect(accountRefusal(null).status).toBe(401);
    expect(accountRefusal({ role: 'staff' })).toBeNull();
});

test('internal pages need a Super Admin', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../agent/api.js'), 'utf8');
    expect(source).toContain('app.get("/v1/stats/detailed", authenticateSuperAdmin,');
    expect(source).toContain('app.get("/v1/queue/status", authenticateSuperAdmin,');
    expect(source).toContain('app.get("/v1/connections", authenticateSuperAdmin,');
});

test('the sign-out check reads the backend key with the backend prefix', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../agent/services/signOut.service.js'), 'utf8');
    expect(source).toContain("keyPrefix: 'hospilink:'");
    expect(source).toContain('`blacklist:${token}`');
});
