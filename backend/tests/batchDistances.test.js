// Distances on the feed and the hospital map: cached, fetched in parallel, and
// estimated from the straight line when Google Maps fails.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));

const mockRedis = { store: new Map(), sets: [] };
jest.mock('../src/config/redis', () => ({
    getClientAsync: async () => ({
        mget: async (...keys) => keys.map(k => mockRedis.store.get(k) ?? null),
        pipeline: () => {
            const p = { setex: (k, ttl, v) => { mockRedis.sets.push({ k, ttl }); mockRedis.store.set(k, v); return p; }, exec: async () => [] };
            return p;
        }
    })
}));
const mockAxios = { calls: [], fail: false, inFlight: 0, maxInFlight: 0 };
jest.mock('axios', () => ({
    get: async (url, { params }) => {
        mockAxios.calls.push(params.destinations.split('|').length);
        mockAxios.inFlight++;
        mockAxios.maxInFlight = Math.max(mockAxios.maxInFlight, mockAxios.inFlight);
        await new Promise(r => setTimeout(r, 5));
        mockAxios.inFlight--;
        if (mockAxios.fail) throw new Error('quota');
        const elements = params.destinations.split('|').map(() => ({ status: 'OK', distance: { value: 12345, text: '12.3 km' }, duration: { value: 1500, text: '25 mins' } }));
        return { data: { status: 'OK', rows: [{ elements }] } };
    }
}));

process.env.GOOGLE_MAPS_API_KEY = 'test-key';
const geocoding = require('../src/services/geocoding.service');

const dests = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, latitude: 18.5 + i * 0.01, longitude: 73.8 }));

beforeEach(() => {
    mockRedis.store.clear();
    mockRedis.sets.length = 0;
    mockAxios.calls.length = 0;
    mockAxios.fail = false;
    mockAxios.maxInFlight = 0;
});

describe('batch distances', () => {
    it('sends batches of 25 at the same time and caches each pair for 10 minutes', async () => {
        const { resultMap, totalApiCalls } = await geocoding.calculateBatchDistanceAndETA(18.52, 73.85, dests(60));
        expect(totalApiCalls).toBe(3);
        expect(mockAxios.calls).toEqual([25, 25, 10]);
        expect(mockAxios.maxInFlight).toBe(3);
        expect(resultMap.size).toBe(60);
        expect(resultMap.get('h0')).toEqual({ distance: 12.35, duration: 25, distanceText: '12.3 km', durationText: '25 mins' });
        expect(mockRedis.sets).toHaveLength(60);
        expect(mockRedis.sets[0].ttl).toBe(600);
    });

    it('asks Maps only for what is not cached, with the origin rounded to about 100 m', async () => {
        await geocoding.calculateBatchDistanceAndETA(18.52, 73.85, dests(30));
        mockAxios.calls.length = 0;
        const { resultMap, totalApiCalls } = await geocoding.calculateBatchDistanceAndETA(18.52004, 73.85003, dests(32));
        expect(totalApiCalls).toBe(1);
        expect(mockAxios.calls).toEqual([2]);
        expect(resultMap.size).toBe(32);
    });

    it('estimates from the straight line when Maps fails, instead of failing', async () => {
        mockAxios.fail = true;
        const { resultMap } = await geocoding.calculateBatchDistanceAndETA(18.52, 73.85, [{ id: 'h', latitude: 18.62, longitude: 73.85 }]);
        const result = resultMap.get('h');
        expect(result.estimated).toBe(true);
        expect(result.distance).toBeGreaterThan(11 * 1.3 - 1);
        expect(result.distance).toBeLessThan(11.2 * 1.3 + 1);
        expect(result.durationText).toMatch(/^about \d+ mins$/);
        expect(mockRedis.sets).toHaveLength(0);
    });

    it('returns nothing for no destinations without calling Maps', async () => {
        expect((await geocoding.calculateBatchDistanceAndETA(18.5, 73.8, [])).totalApiCalls).toBe(0);
        expect(mockAxios.calls).toHaveLength(0);
    });
});
