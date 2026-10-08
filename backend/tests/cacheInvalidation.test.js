// The Redis client adds 'hospilink:' to keys but not to SCAN patterns. Pattern
// invalidation must match the stored names and delete them without a second prefix.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const mockStore = new Map();
const mockCalls = { scan: [], unlink: [] };
const mockClient = {
    options: { keyPrefix: 'hospilink:' },
    // Like ioredis: SCAN sees raw names; other commands get the prefix added
    scan: async (cursor, match, pattern) => {
        mockCalls.scan.push(pattern);
        const re = new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        return ['0', [...mockStore.keys()].filter(k => re.test(k))];
    },
    unlink: async (...keys) => { mockCalls.unlink.push(keys); keys.forEach(k => mockStore.delete(`hospilink:${k}`)); return keys.length; },
    get: async (k) => mockStore.get(`hospilink:${k}`) ?? null,
    multi: () => {
        const ops = [];
        const chain = {
            incr: (k) => { ops.push(() => mockStore.set(`hospilink:${k}`, String(Number(mockStore.get(`hospilink:${k}`) || 0) + 1))); return chain; },
            expire: () => chain,
            exec: async () => { ops.forEach(op => op()); return []; }
        };
        return chain;
    }
};
jest.mock('../src/config/redis', () => ({ getClientAsync: async () => mockClient }));

const cacheService = require('../src/services/cache.service');

beforeEach(() => {
    mockStore.clear();
    mockCalls.scan.length = 0;
    mockCalls.unlink.length = 0;
});

describe('pattern invalidation', () => {
    it('finds prefixed keys and deletes them without a second prefix', async () => {
        mockStore.set('hospilink:session:u1', '1');
        mockStore.set('hospilink:session:u2', '1');
        mockStore.set('hospilink:profile:u1:staff', '1');
        const removed = await cacheService.invalidatePattern('session:*');
        expect(removed).toBe(2);
        expect(mockCalls.scan[0]).toBe('hospilink:session:*');
        expect(mockCalls.unlink[0].sort()).toEqual(['session:u1', 'session:u2']);
        expect([...mockStore.keys()]).toEqual(['hospilink:profile:u1:staff']);
    });
});

describe('cache generations', () => {
    it('a new generation gives new map keys in one write', async () => {
        const before = await cacheService.nearbyStaffKey('h1', 10, null);
        await cacheService.invalidateAllNearbyStaff();
        const after = await cacheService.nearbyStaffKey('h1', 10, null);
        expect(before).toBe('nearby:staff:g0:h1:10:all');
        expect(after).toBe('nearby:staff:g1:h1:10:all');
        expect(mockCalls.scan).toHaveLength(0);
    });
});

describe('hot paths', () => {
    it('availability, privacy, blocking and calendar changes never scan the keyspace', () => {
        const fs = require('fs');
        const path = require('path');
        for (const file of ['services/profile.service.js', 'services/admin.service.js', 'services/block.service.js', 'services/dutyCalendar.service.js']) {
            const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
            expect({ file, scans: /invalidatePattern\(/.test(source) }).toEqual({ file, scans: false });
        }
    });
});
