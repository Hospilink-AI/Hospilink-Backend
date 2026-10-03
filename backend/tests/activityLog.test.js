const fs = require('fs');
const path = require('path');

const mockLogged = [];
jest.mock('../src/services/activityLog.service', () => ({
    logActivity: async (actor, action, target, details, req, options) => mockLogged.push({ actor, action, target, details, options }),
    logSystemActivity: async () => {}
}));
const mockCounts = new Map();
jest.mock('../src/config/redis', () => ({
    getClientAsync: async () => ({
        incr: async (k) => { mockCounts.set(k, (mockCounts.get(k) || 0) + 1); return mockCounts.get(k); },
        expire: async () => 1
    })
}));

const { ACTIVITY_ACTIONS, ACTION_CATEGORY_MAP, ACTIVITY_CATEGORIES } = require('../src/utils/activityLog.constants');
const activityLogEmitter = require('../src/services/activityLogEmitter');

const SRC = path.join(__dirname, '../src');
const allSource = () => {
    const out = [];
    (function walk(d) {
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (p.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
        }
    })(SRC);
    return out.join('\n');
};

describe('activity log constants', () => {
    it('gives every action a category the model accepts', () => {
        const categories = Object.values(ACTIVITY_CATEGORIES);
        for (const action of Object.keys(ACTIVITY_ACTIONS)) {
            expect(categories).toContain(ACTION_CATEGORY_MAP[action]);
        }
    });

    it('only uses actions that exist', () => {
        const used = new Set([...allSource().matchAll(/ACTIVITY_ACTIONS\.([A-Z_]+)/g)].map(m => m[1]));
        expect([...used].filter(a => !ACTIVITY_ACTIONS[a])).toEqual([]);
    });

    it('only uses target types the model accepts', () => {
        const model = fs.readFileSync(path.join(SRC, 'models/ActivityLog.js'), 'utf8');
        const allowed = [...model.slice(model.indexOf("enum: ['duty'")).split(']')[0].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
        const used = new Set([...allSource().matchAll(/\{\s*type:\s*'([a-z_]+)',\s*id:/g)].map(m => m[1]));
        expect([...used].filter(t => !allowed.includes(t))).toEqual([]);
    });
});

describe('logAction', () => {
    it('records the signed-in user as the actor', async () => {
        mockLogged.length = 0;
        const req = { user: { _id: 'u1', name: 'Asha', role: 'hospital', email: 'a@x' } };
        await activityLogEmitter.logAction(ACTIVITY_ACTIONS.VACANCY_CLOSED, req, { type: 'vacancy', id: 'v1', name: 'Night RMO' }, { reason: 'filled' });
        expect(mockLogged[0]).toMatchObject({
            action: 'VACANCY_CLOSED',
            actor: { userId: 'u1', name: 'Asha', role: 'hospital' },
            target: { type: 'vacancy', id: 'v1', name: 'Night RMO' },
            details: { reason: 'filled' }
        });
    });
});

describe('repeated failed sign-ins', () => {
    it('raises one security event at the fifth failure in the window', async () => {
        mockLogged.length = 0;
        for (let i = 0; i < 7; i++) await activityLogEmitter.trackFailedLogin('Someone@Example.com', {});
        const raised = mockLogged.filter(l => l.action === 'MULTIPLE_FAILED_LOGINS');
        expect(raised).toHaveLength(1);
        expect(raised[0].details).toMatchObject({ attempts: 5, windowMinutes: 15 });
        expect(raised[0].options).toEqual({ status: 'CRITICAL' });
        expect(mockCounts.get('security:failed-login:someone@example.com')).toBe(7);
    });
});
