jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockCache = new Map();
jest.mock('../src/services/cache.service', () => ({
    get: async (k) => (mockCache.has(k) ? mockCache.get(k) : null),
    set: async (k, v, ttl) => { mockCache.set(k, v); mockCache.set(`ttl:${k}`, ttl); return true; }
}));
const mockRedis = new Map();
jest.mock('../src/config/redis', () => ({
    getClientAsync: async () => ({
        get: async (k) => mockRedis.get(k) || null,
        setex: async (k, ttl, v) => { mockRedis.set(k, v); }
    })
}));

const geocoding = require('../src/services/geocoding.service');
const maps = require('../src/services/maps.service');
const controller = require('../src/controllers/maps.controller');

const components = [
    { long_name: '12', types: ['street_number'] },
    { long_name: 'FC Road', types: ['route'] },
    { long_name: 'Shivajinagar', types: ['sublocality_level_1', 'sublocality'] },
    { long_name: 'Pune', types: ['locality', 'political'] },
    { long_name: 'Pune Division', types: ['administrative_area_level_2'] },
    { long_name: 'Maharashtra', types: ['administrative_area_level_1'] },
    { long_name: '411005', types: ['postal_code'] }
];

beforeEach(() => { mockCache.clear(); mockRedis.clear(); });

function call(handler, query) {
    return new Promise((resolve) => {
        const res = {
            code: null,
            status(c) { this.code = c; return this; },
            json(body) { resolve({ code: this.code, body }); return this; }
        };
        handler({ query }, res, (error) => resolve({ code: error.statusCode, body: { message: error.message } }));
    });
}

describe('address search', () => {
    it('returns the place and caches it for a day, keyed without the typed text', async () => {
        geocoding.geocodeAddress = jest.fn(async () => ({ latitude: 18.53, longitude: 73.84, formattedAddress: 'FC Road, Pune' }));
        const res = await call(controller.geocode, { q: '  FC Road   Pune ' });
        expect(res.body).toEqual({ success: true, latitude: 18.53, longitude: 73.84, formattedAddress: 'FC Road, Pune' });

        await call(controller.geocode, { q: 'fc road pune' });
        expect(geocoding.geocodeAddress).toHaveBeenCalledTimes(1);
        const key = [...mockCache.keys()].find(k => k.startsWith('maps:geocode:'));
        expect(key).not.toMatch(/pune/i);
        expect(mockCache.get(`ttl:${key}`)).toBe(86400);
    });

    it('returns 404 when nothing matches, and remembers that for an hour', async () => {
        geocoding.geocodeAddress = jest.fn(async () => { throw new Error('Geocoding failed: ZERO_RESULTS'); });
        expect((await call(controller.geocode, { q: 'zzzz nowhere' })).code).toBe(404);
        await call(controller.geocode, { q: 'zzzz nowhere' });
        expect(geocoding.geocodeAddress).toHaveBeenCalledTimes(1);
    });

    it('returns 503 and caches nothing when Google is unavailable', async () => {
        geocoding.geocodeAddress = jest.fn(async () => { throw new Error('timeout of 10000ms exceeded'); });
        expect((await call(controller.geocode, { q: 'FC Road' })).code).toBe(503);
        expect(mockCache.size).toBe(0);
    });

    it('checks the search length', async () => {
        expect((await call(controller.geocode, { q: 'ab' })).code).toBe(400);
        expect((await call(controller.geocode, { q: 'x'.repeat(201) })).code).toBe(400);
        expect((await call(controller.geocode, {})).code).toBe(400);
    });
});

describe('pin lookup', () => {
    it('builds street, city, state and pincode', async () => {
        geocoding.reverseGeocode = jest.fn(async () => ({ formattedAddress: '12 FC Road, Pune', components }));
        const res = await call(controller.reverseGeocode, { lat: '18.5308', lng: '73.8475' });
        expect(res.body).toEqual({
            success: true, formattedAddress: '12 FC Road, Pune',
            street: '12 FC Road', city: 'Pune', state: 'Maharashtra', pincode: '411005'
        });
        expect(mockCache.has('maps:reverse:18.5308:73.8475')).toBe(true);
    });

    it('falls back to the area and district when there is no road or locality', () => {
        const parts = maps.addressParts(components.filter(c => !['street_number', 'route', 'locality'].includes(c.types[0])));
        expect(parts).toMatchObject({ street: 'Shivajinagar', city: 'Pune Division' });
    });

    it('rejects bad coordinates', async () => {
        for (const query of [{ lat: 'abc', lng: '73' }, { lat: '91', lng: '73' }, { lat: '18' }, { lat: '', lng: '' }]) {
            expect((await call(controller.reverseGeocode, query)).code).toBe(400);
        }
    });
});

describe('directions cache', () => {
    it('reuses a route for ten minutes for nearby start points', async () => {
        geocoding._fetchDirections = jest.fn(async () => ({ distance: 5.2, overviewPolyline: 'abc' }));
        const first = await geocoding.getDirections(18.53012, 73.84721, 18.5204, 73.8567);
        const second = await geocoding.getDirections(18.53031, 73.84739, 18.5204, 73.8567);
        expect(second).toEqual(first);
        expect(geocoding._fetchDirections).toHaveBeenCalledTimes(1);
    });
});
