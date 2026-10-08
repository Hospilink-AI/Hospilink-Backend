const os = require('os');
const redisClient = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Who is connected, across every server task.
 *
 * Socket.IO rooms only show the sockets on this task. Each user gets a Redis
 * hash `presence:<userId>` of socketId -> task. A task adds a field on connect,
 * removes it on disconnect, and renews the key's expiry for its users every
 * minute, so a task that dies without cleaning up drops out within
 * PRESENCE_TTL_SECONDS.
 */
const PRESENCE_TTL_SECONDS = 150;
const REFRESH_MS = 60 * 1000;
const BATCH = 500;

const taskId = `${process.env.HOSTNAME || os.hostname()}:${process.pid}`;
const keyFor = (userId) => `presence:${userId}`;

let io = null;
let refreshTimer = null;

function localRoomSize(userId) {
    try {
        const room = io?.of('/').adapter.rooms.get(`user:${userId}`);
        return room ? room.size : 0;
    } catch (err) {
        return 0;
    }
}

async function connected(userId, socketId) {
    try {
        const client = await redisClient.getClientAsync();
        await client.multi()
            .hset(keyFor(userId), socketId, taskId)
            .expire(keyFor(userId), PRESENCE_TTL_SECONDS)
            .exec();
    } catch (err) {
        logger.warn(`Presence connect not recorded: ${err.message}`);
    }
}

async function disconnected(userId, socketId) {
    try {
        const client = await redisClient.getClientAsync();
        await client.hdel(keyFor(userId), socketId);
    } catch (err) {
        logger.warn(`Presence disconnect not recorded: ${err.message}`);
    }
}

// Renew the expiry for every user connected to this task
async function refresh() {
    if (!io) return;
    const userIds = [];
    for (const room of io.of('/').adapter.rooms.keys()) {
        if (room.startsWith('user:')) userIds.push(room.slice(5));
    }
    if (userIds.length === 0) return;
    try {
        const client = await redisClient.getClientAsync();
        for (let i = 0; i < userIds.length; i += BATCH) {
            const pipeline = client.pipeline();
            for (const userId of userIds.slice(i, i + BATCH)) {
                pipeline.expire(keyFor(userId), PRESENCE_TTL_SECONDS);
            }
            await pipeline.exec();
        }
    } catch (err) {
        logger.warn(`Presence refresh failed: ${err.message}`);
    }
}

function start(socketServer) {
    io = socketServer;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, REFRESH_MS);
    refreshTimer.unref();
}

function stop() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
}

/**
 * Online user ids among `userIds`. Sockets on this task answer without Redis;
 * the rest are checked in batched EXISTS calls. If Redis can't be read the
 * user counts as offline, so they get a push rather than nothing.
 */
async function onlineAmong(userIds) {
    const ids = [...new Set((userIds || []).map(String))];
    const online = new Set();
    const toCheck = [];
    for (const id of ids) {
        if (localRoomSize(id) > 0) online.add(id);
        else toCheck.push(id);
    }
    if (toCheck.length > 0) {
        try {
            const client = await redisClient.getClientAsync();
            for (let i = 0; i < toCheck.length; i += BATCH) {
                const slice = toCheck.slice(i, i + BATCH);
                const pipeline = client.pipeline();
                slice.forEach(id => pipeline.exists(keyFor(id)));
                const results = await pipeline.exec();
                results.forEach(([err, exists], index) => {
                    if (!err && exists === 1) online.add(slice[index]);
                });
            }
        } catch (err) {
            logger.warn(`Presence check failed, treating users as offline: ${err.message}`);
        }
    }
    return online;
}

async function isOnline(userId) {
    if (!userId) return false;
    const online = await onlineAmong([userId]);
    return online.has(String(userId));
}

module.exports = {
    PRESENCE_TTL_SECONDS,
    start,
    stop,
    connected,
    disconnected,
    refresh,
    isOnline,
    onlineAmong
};
