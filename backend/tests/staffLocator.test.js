// Fake Redis: GEO set plus plain keys, enough for the locator
const store = new Map();
const geo = new Map();
const fakeRedis = {
    get: async (k) => store.get(k) ?? null,
    mget: async (keys) => keys.map(k => store.get(k) ?? null),
    geoadd: async (key, lng, lat, member) => geo.set(member, [lng, lat]),
    zrem: async (key, ...members) => members.forEach(m => geo.delete(m)),
    georadius: async (key, lng, lat, radius) => {
        const { haversineKm } = require('../src/services/staffLocator.service');
        return [...geo.entries()]
            .filter(([, [mLng, mLat]]) => haversineKm(lat, lng, mLat, mLng) <= radius)
            .map(([member, [mLng, mLat]]) => [member, [String(mLng), String(mLat)]]);
    }
};
jest.mock('../src/config/redis', () => ({ getClientAsync: async () => fakeRedis }));
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const MedicalStaff = require('../src/models/MedicalStaff');
const staffLocator = require('../src/services/staffLocator.service');
const { boundingBox, haversineKm, normalizeCity } = staffLocator;

const PUNE = { latitude: 18.5204, longitude: 73.8567 };
// Roughly 10 km and 40 km north of the hospital
const north = (km) => ({ latitude: PUNE.latitude + km / 111, longitude: PUNE.longitude });

describe('geometry', () => {
    it('uses degrees, not radians, for the search box', () => {
        const box = boundingBox(PUNE.latitude, PUNE.longitude, 50);
        expect(box.maxLat - PUNE.latitude).toBeCloseTo(0.45, 2);
        expect(box.maxLng - PUNE.longitude).toBeGreaterThan(0.45);
    });

    it('measures straight-line distance', () => {
        expect(haversineKm(PUNE.latitude, PUNE.longitude, north(10).latitude, north(10).longitude)).toBeCloseTo(10, 0);
    });

    it('treats city spellings with different case and spacing as one', () => {
        expect(normalizeCity('  Pune ')).toBe('pune');
        expect(normalizeCity('Navi   Mumbai')).toBe('navi mumbai');
    });
});

describe('findInRadius', () => {
    const staff = [
        { _id: 'a', user: 'ua', fullName: 'Home near', jobRole: 'RMO', verificationStatus: 'verified', isAvailable: true, coordinates: { coordinates: north(10) } },
        { _id: 'b', user: 'ub', fullName: 'Home near, live far', jobRole: 'rmo', verificationStatus: 'verified', isAvailable: true, coordinates: { coordinates: north(5) } },
        { _id: 'c', user: 'uc', fullName: 'Home far, live near', jobRole: 'rmo', verificationStatus: 'verified', isAvailable: true, coordinates: { coordinates: north(200) } },
        { _id: 'd', user: 'ud', fullName: 'Not verified', jobRole: 'rmo', verificationStatus: 'pending', isAvailable: true, coordinates: { coordinates: north(3) } },
        { _id: 'e', user: 'ue', fullName: 'Stale live, home far', jobRole: 'rmo', verificationStatus: 'verified', isAvailable: true, coordinates: { coordinates: north(300) } }
    ];

    beforeAll(() => {
        // Simple stand-in for the Mongo filters the locator uses
        MedicalStaff.find = (q) => {
            const inBox = (s) => {
                const lat = q['coordinates.coordinates.latitude'];
                const lng = q['coordinates.coordinates.longitude'];
                const c = s.coordinates.coordinates;
                return !lat || (c.latitude >= lat.$gte && c.latitude <= lat.$lte && c.longitude >= lng.$gte && c.longitude <= lng.$lte);
            };
            const rows = staff.filter(s =>
                s.verificationStatus === q.verificationStatus &&
                s.isAvailable === q.isAvailable &&
                (!q.jobRole || new RegExp(q.jobRole.$regex, q.jobRole.$options).test(s.jobRole)) &&
                (!q.user || q.user.$in.includes(s.user)) &&
                inBox(s));
            return { select: () => ({ lean: async () => rows }) };
        };

        const now = JSON.stringify({});
        store.set('dashboard:location:ub', now);
        store.set('dashboard:location:uc', now);
        geo.set('ub', [north(120).longitude, north(120).latitude]);
        geo.set('uc', [north(8).longitude, north(8).latitude]);
        geo.set('ue', [north(6).longitude, north(6).latitude]); // no fresh key
        store.set('dashboard:location:ub', JSON.stringify(north(120)));
        store.set('dashboard:location:uc', JSON.stringify(north(8)));
    });

    it('finds staff by home, lets a fresh live position win, and drops stale or unverified ones', async () => {
        const found = await staffLocator.findInRadius(PUNE, 'rmo', 30);
        expect(found.map(s => [s.fullName, s.distanceSource])).toEqual([
            ['Home far, live near', 'live'],
            ['Home near', 'home']
        ]);
        expect(found[0].user._id).toBe('uc');
    });

    it('cleans stale members out of the live set', () => {
        expect(geo.has('ue')).toBe(false);
    });

    it('leaves out excluded staff', async () => {
        const found = await staffLocator.findInRadius(PUNE, 'rmo', 30, { excludeStaffIds: ['a'] });
        expect(found.map(s => s._id)).toEqual(['c']);
    });

    it('widens with the radius', async () => {
        const found = await staffLocator.findInRadius(PUNE, 'rmo', 150);
        expect(found.map(s => s._id)).toEqual(['c', 'a', 'b']);
    });
});
