// The admin OTP email allowance is enforced. Before, its "too many" error
// was swallowed by .catch(() => true), so admins could request unlimited
// OTP emails.
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockSent = [];
jest.mock('../src/services/email.service', () => ({
    sendAdminOTPEmail: async (email) => { mockSent.push(email); return true; }
}));
let mockCount = 0;
let mockRedisDown = false;
jest.mock('../src/config/redis', () => ({
    getClientAsync: async () => {
        if (mockRedisDown) throw new Error('redis down');
        return {
            eval: async () => ++mockCount,
            ttl: async () => 1800,
            setex: async () => 'OK'
        };
    }
}));

const User = require('../src/models/User');
const adminAuth = require('../src/services/adminAuth.service');

let admin;
beforeEach(() => {
    mockCount = 0;
    mockRedisDown = false;
    mockSent.length = 0;
    delete process.env.ADMIN_OTP_RATE_LIMIT;
    admin = { _id: 'a1', email: 'admin@test.in', name: 'TEST', isActive: true, comparePassword: async (p) => p === 'right' };
    User.findOne = () => { const q = Promise.resolve(admin); q.select = () => Promise.resolve(admin); return q; };
    User.updateOne = async () => ({});
});

test('the fourth OTP request within the window is refused', async () => {
    for (let i = 0; i < 3; i++) await adminAuth.signin('admin@test.in', 'right');
    await expect(adminAuth.signin('admin@test.in', 'right')).rejects.toThrow(/Too many OTP requests/);
    await expect(adminAuth.resendOTP('admin@test.in')).rejects.toThrow(/Too many OTP requests/);
});

test('a wrong password does not use up the allowance', async () => {
    for (let i = 0; i < 5; i++) {
        await expect(adminAuth.signin('admin@test.in', 'wrong')).rejects.toThrow(/Invalid email or password/);
    }
    expect(mockCount).toBe(0);
    await adminAuth.signin('admin@test.in', 'right');
});

test('ADMIN_OTP_RATE_LIMIT changes the allowance', async () => {
    process.env.ADMIN_OTP_RATE_LIMIT = '1';
    await adminAuth.signin('admin@test.in', 'right');
    await expect(adminAuth.signin('admin@test.in', 'right')).rejects.toThrow(/Too many OTP requests/);
});

test('Redis down does not lock admins out', async () => {
    mockRedisDown = true;
    // The OTP itself is stored in Redis too; only the allowance check must not block
    const check = adminAuth._checkRateLimit('admin@test.in');
    await expect(check).resolves.toBeUndefined();
});
