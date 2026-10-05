const MedicalStaff = require('../models/MedicalStaff');
const redisClient = require('../config/redis');
const logger = require('../utils/logger');

// One degree of latitude is ~111 km everywhere; a degree of longitude shrinks
// with the cosine of the latitude.
const KM_PER_DEGREE = 111;
const EARTH_RADIUS_KM = 6371;

// Redis GEO set of staff who are sharing their live position. A member is
// only trusted while its dashboard:location:<userId> key (120s TTL) exists.
const LIVE_GEO_KEY = 'staff:live';
const liveLocationKey = (userId) => `dashboard:location:${userId}`;

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function boundingBox(lat, lng, radiusKm) {
    const latDelta = radiusKm / KM_PER_DEGREE;
    const lngDelta = radiusKm / (KM_PER_DEGREE * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
    return { minLat: lat - latDelta, maxLat: lat + latDelta, minLng: lng - lngDelta, maxLng: lng + lngDelta };
}

// Straight-line distance in km
function haversineKm(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 'Pune ', 'PUNE' and 'pune' are the same city
function normalizeCity(city) {
    return (city || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const homePoint = (staff) => {
    const c = staff.coordinates?.coordinates;
    return c && typeof c.latitude === 'number' && typeof c.longitude === 'number'
        ? { latitude: c.latitude, longitude: c.longitude }
        : null;
};

class StaffLocatorService {
    // Staff who can be offered work: verified, not suspended, available, and
    // demo only for demo hospitals
    _eligibleFilter(role, demo = false) {
        return {
            verificationStatus: 'verified',
            isSuspended: { $ne: true },
            isAvailable: true,
            isDemo: demo ? true : { $ne: true },
            ...(role && { jobRole: { $regex: `^${escapeRegex(role.trim())}$`, $options: 'i' } })
        };
    }



    // --- Live positions (kept in step with dashboard:location:<userId>) ---

    async addLivePosition(userId, latitude, longitude) {
        try {
            const client = await redisClient.getClientAsync();
            await client.geoadd(LIVE_GEO_KEY, longitude, latitude, String(userId));
        } catch (error) {
            logger.error('Error saving live staff position:', error);
        }
    }

    async removeLivePosition(userId) {
        try {
            const client = await redisClient.getClientAsync();
            await client.zrem(LIVE_GEO_KEY, String(userId));
        } catch (error) {
            logger.error('Error removing live staff position:', error);
        }
    }

    // userId -> { latitude, longitude } for staff whose live position is fresh
    async _liveNear(latitude, longitude, radiusKm) {
        try {
            const client = await redisClient.getClientAsync();
            const members = await client.georadius(LIVE_GEO_KEY, longitude, latitude, radiusKm, 'km', 'WITHCOORD');
            if (!members.length) return new Map();

            const userIds = members.map(m => m[0]);
            const fresh = await client.mget(userIds.map(liveLocationKey));

            const live = new Map();
            const stale = [];
            members.forEach(([userId, [lng, lat]], i) => {
                if (fresh[i]) live.set(userId, { latitude: Number(lat), longitude: Number(lng) });
                else stale.push(userId);
            });
            if (stale.length) client.zrem(LIVE_GEO_KEY, ...stale).catch(() => {});
            return live;
        } catch (error) {
            logger.error('Error reading live staff positions:', error);
            return new Map();
        }
    }

    // Live position if the app sent one in the last 2 minutes, else home
    async positionOf(staff) {
        const userId = staff.user?._id || staff.user;
        if (userId) {
            try {
                const client = await redisClient.getClientAsync();
                const raw = await client.get(liveLocationKey(userId));
                if (raw) {
                    const { latitude, longitude } = JSON.parse(raw);
                    return { latitude, longitude, source: 'live' };
                }
            } catch (error) {
                logger.error('Error reading live staff position:', error);
            }
        }
        const home = homePoint(staff);
        return home ? { ...home, source: 'home' } : null;
    }



    // Staff within radiusKm (straight line) of a point. A doctor's fresh live
    // position wins over their home address. No Maps calls.
    // Returns [{ _id, user: { _id }, fullName, jobRole, distance, distanceSource }], nearest first.
    async findInRadius(center, role, radiusKm, { excludeStaffIds = [], demo = false } = {}) {
        const excluded = new Set(excludeStaffIds.map(String));
        const box = boundingBox(center.latitude, center.longitude, radiusKm);

        const live = await this._liveNear(center.latitude, center.longitude, radiusKm);
        const [byHome, byLive] = await Promise.all([
            MedicalStaff.find({
                ...this._eligibleFilter(role, demo),
                'coordinates.coordinates.latitude': { $gte: box.minLat, $lte: box.maxLat },
                'coordinates.coordinates.longitude': { $gte: box.minLng, $lte: box.maxLng }
            }).select('user fullName jobRole coordinates').lean(),
            live.size
                ? MedicalStaff.find({ ...this._eligibleFilter(role, demo), user: { $in: [...live.keys()] } })
                    .select('user fullName jobRole coordinates').lean()
                : []
        ]);

        // Anyone sharing a live position is judged by it, wherever they live
        const liveAnywhere = await this._liveFor([...byHome].map(s => String(s.user)), live);

        const result = new Map();
        for (const staff of [...byHome, ...byLive]) {
            const id = String(staff._id);
            if (excluded.has(id) || result.has(id)) continue;

            const userId = String(staff.user);
            const livePoint = live.get(userId) || liveAnywhere.get(userId);
            const point = livePoint || homePoint(staff);
            if (!point) continue;

            const distance = haversineKm(center.latitude, center.longitude, point.latitude, point.longitude);
            if (distance > radiusKm) continue;

            result.set(id, {
                _id: staff._id,
                user: { _id: staff.user },
                fullName: staff.fullName,
                jobRole: staff.jobRole,
                distance: Math.round(distance * 10) / 10,
                distanceSource: livePoint ? 'live' : 'home'
            });
        }

        return [...result.values()].sort((a, b) => a.distance - b.distance);
    }

    // Fresh live positions for users found by home address but sharing a live
    // position outside the search circle
    async _liveFor(userIds, alreadyKnown) {
        const missing = userIds.filter(id => !alreadyKnown.has(id));
        if (!missing.length) return new Map();
        try {
            const client = await redisClient.getClientAsync();
            const raw = await client.mget(missing.map(liveLocationKey));
            const map = new Map();
            raw.forEach((value, i) => {
                if (!value) return;
                const { latitude, longitude } = JSON.parse(value);
                map.set(missing[i], { latitude, longitude });
            });
            return map;
        } catch (error) {
            logger.error('Error reading live staff positions:', error);
            return new Map();
        }
    }



    // Staff whose profile city matches (case and spacing ignored)
    async findInCity(city, role, { excludeStaffIds = [], demo = false } = {}) {
        const normalized = normalizeCity(city);
        if (!normalized) return [];
        const excluded = new Set(excludeStaffIds.map(String));

        const pattern = `^\\s*${normalized.split(' ').map(escapeRegex).join('\\s+')}\\s*$`;
        const staff = await MedicalStaff.find({
            ...this._eligibleFilter(role, demo),
            city: { $regex: pattern, $options: 'i' }
        }).select('user fullName jobRole').lean();

        return staff
            .filter(s => !excluded.has(String(s._id)))
            .map(s => ({ _id: s._id, user: { _id: s.user }, fullName: s.fullName, jobRole: s.jobRole }));
    }
}

const staffLocator = new StaffLocatorService();
staffLocator.boundingBox = boundingBox;
staffLocator.haversineKm = haversineKm;
staffLocator.normalizeCity = normalizeCity;

module.exports = staffLocator;
