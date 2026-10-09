// Shared helpers for duty.service.js and its method groups in ./
const { calculateDutyDuration } = require('../../utils/helpers');
const DashboardService = require('../dashboard.service');
const redisClient = require('../../config/redis');

// Actor for changes the platform makes on its own (expiry, incomplete, pending confirmation)
const SYSTEM_ACTOR = { userId: null, name: 'System', role: 'system' };

// Fields the doctor's statement and receipt read
const EARNINGS_DUTY_FIELDS = 'hospital assignedTo staffRole dutySubType status date endDate startTime endTime ' +
    'isOvernightDuty urgency offeredRate totalPayment completedAt paymentMethod isPaid paymentAttestedAt';

// 'paid', 'pending' (will pay later, or marked unpaid) or 'unconfirmed'
function paymentStatusOf(duty) {
    if (duty.isPaid === true) return 'paid';
    if (duty.isPaid === false || duty.paymentMethod === 'will_pay_later') return 'pending';
    return 'unconfirmed';
}

function dutyHours(duty) {
    return calculateDutyDuration(duty.date, duty.startTime, duty.endTime, duty.isOvernightDuty, duty.endDate);
}

// Per-duty Redis lock TTL in seconds — prevents thundering herd
const DUTY_ACCEPT_LOCK_TTL = 10;

const LOCATION_UPDATE_MAX_AGE_MS = parseInt(process.env.STAFF_LOCATION_MAX_AGE_MS, 10) || 90 * 1000;

/**
 * Acquire a short-lived Redis lock for a specific duty acceptance attempt.
 * Returns true if lock acquired, false if another request already holds it.
 * Uses SET NX EX (atomic in Redis) — no race condition possible.
 */
async function acquireDutyLock(dutyId, staffId) {
    try {
        const redis = await redisClient.getClientAsync();
        const key = `duty_accept_lock:${dutyId}:${staffId}`;
        // NX = only set if not exists, EX = expire after TTL
        const result = await redis.set(key, '1', 'EX', DUTY_ACCEPT_LOCK_TTL, 'NX');
        return result === 'OK';
    } catch {
        // Redis unavailable — fail open (allow the request through)
        return true;
    }
}

async function releaseDutyLock(dutyId, staffId) {
    try {
        const redis = await redisClient.getClientAsync();
        await redis.del(`duty_accept_lock:${dutyId}:${staffId}`);
    } catch {
        // Best-effort — TTL will clean it up anyway
    }
}

// The live position from the socket when it is fresh, otherwise the position
// the app sent with the request
async function resolveStaffLocation(staffUserId, sentLocation) {
    const live = await getRecentStaffLocation(staffUserId);
    if (live) return live;
    if (sentLocation && typeof sentLocation.latitude === 'number' && typeof sentLocation.longitude === 'number') {
        return { latitude: sentLocation.latitude, longitude: sentLocation.longitude, timestamp: Date.now(), source: 'request' };
    }
    return null;
}

async function getRecentStaffLocation(staffUserId) {
    try {
        const dashboardLocation = await DashboardService.getDashboardLocation(staffUserId);
        if (!dashboardLocation || typeof dashboardLocation.latitude !== 'number' || typeof dashboardLocation.longitude !== 'number' || !dashboardLocation.updatedAt) {
            return null;
        }

        const timestamp = Date.parse(dashboardLocation.updatedAt);
        if (Number.isNaN(timestamp) || (Date.now() - timestamp) > LOCATION_UPDATE_MAX_AGE_MS) {
            return null;
        }

        return {
            latitude: dashboardLocation.latitude,
            longitude: dashboardLocation.longitude,
            timestamp,
            source: dashboardLocation.source || 'websocket'
        };
    } catch (error) {
        return null;
    }
}

module.exports = { SYSTEM_ACTOR, EARNINGS_DUTY_FIELDS, paymentStatusOf, dutyHours, DUTY_ACCEPT_LOCK_TTL, LOCATION_UPDATE_MAX_AGE_MS, acquireDutyLock, releaseDutyLock, resolveStaffLocation, getRecentStaffLocation };
