// After a deploy every app reconnects at once. A reconnect reads the cached
// session, profile and suspension in one Redis call instead of the database.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const mockCache = new Map();
let mockRedisDown = false;
const mockWrites = [];
jest.mock('../src/services/cache.service', () => ({
    getManyStrict: async (keys) => {
        if (mockRedisDown) throw new Error('redis down');
        return keys.map(key => (mockCache.has(key) ? mockCache.get(key) : null));
    },
    pipeline: async (ops) => { mockWrites.push(...ops); return []; }
}));

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const MedicalStaff = require('../src/models/MedicalStaff');
const authMiddleware = require('../src/socket/authMiddleware');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const userId = String(new mongoose.Types.ObjectId());
const staffId = new mongoose.Types.ObjectId();
let dbReads;

function connect(token = jwt.sign({ id: userId }, process.env.JWT_SECRET)) {
    const socket = { handshake: { auth: { token }, headers: {} } };
    return new Promise((resolve) => authMiddleware(socket, (err) => resolve({ err, socket })));
}

beforeEach(() => {
    mockCache.clear();
    mockWrites.length = 0;
    mockRedisDown = false;
    dbReads = 0;
    const chain = (value) => {
        const c = { select: () => c, lean: async () => { dbReads++; return value; } };
        return c;
    };
    User.findById = () => chain({ _id: userId, role: 'staff', name: 'TEST' });
    MedicalStaff.findOne = () => chain({ _id: staffId, jobRole: 'rmo', isSuspended: false });
});

test('a warm reconnect needs no database read', async () => {
    mockCache.set(`session:${userId}`, { _id: userId, id: userId, role: 'staff', name: 'TEST', isActive: true });
    mockCache.set(`socketprofile:${userId}`, { role: 'staff', profile: { _id: String(staffId), jobRole: 'rmo' } });
    mockCache.set(`suspension:staff:${userId}`, { isSuspended: false, suspensionReason: null });

    const { err, socket } = await connect();

    expect(err).toBeUndefined();
    expect(dbReads).toBe(0);
    expect(socket.user.id).toBe(userId);
    expect(socket.medicalStaff.jobRole).toBe('rmo');
});

test('a cold connect reads the database once per model and fills the caches', async () => {
    const { err, socket } = await connect();
    expect(err).toBeUndefined();
    expect(dbReads).toBe(2);
    expect(socket.medicalStaff).toEqual({ _id: staffId, jobRole: 'rmo' });
    expect(mockWrites.map(w => w.key).sort()).toEqual([`socketprofile:${userId}`, `suspension:staff:${userId}`]);
});

test('a cached suspension refuses the connection', async () => {
    mockCache.set(`session:${userId}`, { _id: userId, role: 'staff', isActive: true });
    mockCache.set(`socketprofile:${userId}`, { role: 'staff', profile: { _id: String(staffId), jobRole: 'rmo' } });
    mockCache.set(`suspension:staff:${userId}`, { isSuspended: true, suspensionReason: 'TEST' });
    const { err } = await connect();
    expect(err.message).toMatch(/suspended. Reason: TEST/);
});

test('a logged-out token is refused', async () => {
    const token = jwt.sign({ id: userId }, process.env.JWT_SECRET);
    mockCache.set(`blacklist:${token}`, true);
    const { err } = await connect(token);
    expect(err.message).toMatch(/invalidated/);
});

test('Redis down refuses the connection rather than skipping the logout check', async () => {
    mockRedisDown = true;
    const { err } = await connect();
    expect(err).toBeTruthy();
    expect(dbReads).toBe(0);
});

test('a cached deactivated admin session is refused', async () => {
    mockCache.set(`session:${userId}`, { _id: userId, role: 'admin', isActive: false });
    const { err } = await connect();
    expect(err.message).toMatch(/deactivated/);
});
