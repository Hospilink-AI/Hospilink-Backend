// Availability stops new offers only. A doctor who turns it off must still see
// and work the duties they already accepted, including the start/end handshake.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));

const {
    requireStaffVerificationandisAvailable,
    requireVerifiedStaffOnly
} = require('../src/middleware/accountsVerification.middleware');
const router = require('../src/routes/duty.routes');

function handlersFor(method, path) {
    const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
    if (!layer) throw new Error(`no route ${method.toUpperCase()} ${path}`);
    return layer.route.stack.map(s => s.handle);
}

describe('availability gate on duty routes', () => {
    it.each([
        ['get', '/duties/my-upcoming'],
        ['get', '/duties/ongoing'],
        ['get', '/duties/statement'],
        ['patch', '/duties/status'],
        ['post', '/duties/:id/request-start-otp'],
        ['post', '/duties/:id/verify-start-otp'],
        ['post', '/duties/:id/request-end-otp'],
        ['post', '/duties/:id/route']
    ])('%s %s needs a verified doctor, not availability', (method, path) => {
        const handlers = handlersFor(method, path);
        expect(handlers).toContain(requireVerifiedStaffOnly);
        expect(handlers).not.toContain(requireStaffVerificationandisAvailable);
    });

    it.each([
        ['get', '/duties/available'],
        ['post', '/staff/accept-duty']
    ])('%s %s still needs availability on', (method, path) => {
        expect(handlersFor(method, path)).toContain(requireStaffVerificationandisAvailable);
    });
});
