// Online status is shared through Redis, so a user connected to another
// server task gets an in-app notice instead of a push

const mockHashes = new Map();
const mockTtls = new Map();
let mockRedisDown = false;

function mockClient() {
    const queue = [];
    const chain = {
        hset: (key, field, value) => { queue.push(() => { if (!mockHashes.has(key)) mockHashes.set(key, new Map()); mockHashes.get(key).set(field, value); return 1; }); return chain; },
        expire: (key, ttl) => { queue.push(() => { if (!mockHashes.has(key)) return 0; mockTtls.set(key, ttl); return 1; }); return chain; },
        exists: (key) => { queue.push(() => (mockHashes.has(key) && mockHashes.get(key).size > 0 ? 1 : 0)); return chain; },
        exec: async () => queue.splice(0).map(fn => [null, fn()])
    };
    return chain;
}

jest.mock('../src/config/redis', () => ({
    getClientAsync: async () => {
        if (mockRedisDown) throw new Error('redis down');
        return {
            multi: () => mockClient(),
            pipeline: () => mockClient(),
            hdel: async (key, field) => {
                const hash = mockHashes.get(key);
                if (!hash) return 0;
                hash.delete(field);
                if (hash.size === 0) mockHashes.delete(key);
                return 1;
            }
        };
    }
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const presence = require('../src/services/presence.service');

function fakeIo(localUserIds) {
    const rooms = new Map(localUserIds.map(id => [`user:${id}`, new Set(['s-local'])]));
    return { of: () => ({ adapter: { rooms } }) };
}

beforeEach(() => {
    mockHashes.clear();
    mockTtls.clear();
    mockRedisDown = false;
    presence.stop();
});

afterAll(() => presence.stop());

test('a user connected to another task counts as online', async () => {
    presence.start(fakeIo([]));
    await presence.connected('u1', 'socket-a');
    expect(await presence.isOnline('u1')).toBe(true);
    expect(await presence.isOnline('u2')).toBe(false);
    expect(mockTtls.get('presence:u1')).toBe(presence.PRESENCE_TTL_SECONDS);
});

test('the last socket disconnecting makes the user offline', async () => {
    presence.start(fakeIo([]));
    await presence.connected('u1', 'socket-a');
    await presence.connected('u1', 'socket-b');
    await presence.disconnected('u1', 'socket-a');
    expect(await presence.isOnline('u1')).toBe(true);
    await presence.disconnected('u1', 'socket-b');
    expect(await presence.isOnline('u1')).toBe(false);
});

test('local sockets answer without Redis', async () => {
    presence.start(fakeIo(['local-user']));
    mockRedisDown = true;
    expect(await presence.isOnline('local-user')).toBe(true);
});

test('onlineAmong batches the check and mixes local and remote users', async () => {
    presence.start(fakeIo(['a']));
    await presence.connected('b', 'socket-b');
    const online = await presence.onlineAmong(['a', 'b', 'c', 'b']);
    expect([...online].sort()).toEqual(['a', 'b']);
});

test('Redis down means offline, so the user still gets a push', async () => {
    presence.start(fakeIo([]));
    await presence.connected('u1', 'socket-a');
    mockRedisDown = true;
    expect(await presence.isOnline('u1')).toBe(false);
});

test('refresh renews the expiry for users on this task', async () => {
    presence.start(fakeIo(['u1']));
    await presence.connected('u1', 'socket-a');
    mockTtls.clear();
    await presence.refresh();
    expect(mockTtls.get('presence:u1')).toBe(presence.PRESENCE_TTL_SECONDS);
});

describe('delivery uses the shared status', () => {
    test('deliverToUsers sends in-app to users online elsewhere and pushes to the rest', async () => {
        jest.resetModules();
        jest.doMock('../src/services/presence.service', () => ({
            isOnline: async (id) => id === 'remote',
            onlineAmong: async () => new Set(['remote'])
        }));
        const sendToUsers = jest.fn(async () => ({ successCount: 1, failureCount: 0 }));
        jest.doMock('../src/services/fcm.service', () => ({ sendToUsers, sendToUser: jest.fn() }));
        jest.doMock('../src/services/notificationService', () => ({ notificationIdFor: () => 'n1', markAsDelivered: jest.fn() }));
        jest.doMock('../src/services/staffPreferences.service', () => ({ filterPushRecipients: async (ids) => ids }), { virtual: true });
        const websocketManager = require('../src/services/websocketManager');
        const emit = jest.fn();
        websocketManager.setIO({ to: () => ({ emit }) });
        const delivery = require('../src/services/notificationDelivery.service');

        const result = await delivery.deliverToUsers(['remote', 'offline'], 'NEW_DUTY_OFFER', { message: 'x' });

        expect(result.onlineIds).toEqual(['remote']);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(sendToUsers.mock.calls[0][0]).toEqual(['offline']);
    });
});
