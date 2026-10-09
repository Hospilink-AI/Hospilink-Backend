// Live tracking sends a position every few seconds. Maps is asked for the road
// distance at most once a minute per doctor, and arrival uses the straight line.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockStore = new Map();
jest.mock('../src/config/redis', () => ({
    getClientAsync: async () => ({
        get: async (k) => mockStore.get(k) ?? null,
        setex: async (k, ttl, v) => { mockStore.set(k, v); },
        mget: async (...keys) => keys.map(() => null),
        pipeline: () => { const p = { setex: () => p, exec: async () => [] }; return p; }
    })
}));
jest.mock('../src/socket/index', () => ({ getIO: () => ({ to: () => ({ emit: () => {} }) }) }));

const geocoding = require('../src/services/geocoding.service');
const tracking = require('../src/services/locationTracking.service');

const HOSPITAL = { latitude: 18.5204, longitude: 73.8567 };
let mapsCalls;

beforeEach(() => {
    mockStore.clear();
    mapsCalls = 0;
    geocoding.calculateDistanceAndETA = async () => { mapsCalls++; return { distance: 4.2, duration: 12 }; };
    tracking.getHospitalLocation = async () => HOSPITAL;
    tracking.broadcastLocationUpdate = async () => {};
    tracking.handleStaffArrival = jest.fn(async () => {});
    mockStore.set('staff_location:u1', JSON.stringify({ hospitalId: 'h1', status: 'active', latitude: 18.55, longitude: 73.88 }));
});

describe('tracking distance', () => {
    it('asks Maps once for a burst of updates and keeps the road distance between', async () => {
        for (let i = 0; i < 10; i++) {
            await tracking.updateStaffLocation('u1', { latitude: 18.55 - i * 0.001, longitude: 73.88 });
        }
        expect(mapsCalls).toBe(1);
        const saved = JSON.parse(mockStore.get('staff_location:u1'));
        expect(saved.distanceToHospital).toBe(4.2);
        expect(saved.straightLineKm).toBeGreaterThan(3);
    });

    it('asks again once the minute is up', async () => {
        await tracking.updateStaffLocation('u1', { latitude: 18.55, longitude: 73.88 });
        const saved = JSON.parse(mockStore.get('staff_location:u1'));
        saved.routeCheckedAt = Date.now() - 61 * 1000;
        mockStore.set('staff_location:u1', JSON.stringify(saved));
        await tracking.updateStaffLocation('u1', { latitude: 18.549, longitude: 73.88 });
        expect(mapsCalls).toBe(2);
    });

    it('detects arrival within 100 m without Maps', async () => {
        await tracking.checkArrival('u1', { latitude: 18.5208, longitude: 73.8569, status: 'active' }, HOSPITAL);
        expect(tracking.handleStaffArrival).toHaveBeenCalledTimes(1);
        await tracking.checkArrival('u1', { latitude: 18.53, longitude: 73.86, status: 'active' }, HOSPITAL);
        expect(tracking.handleStaffArrival).toHaveBeenCalledTimes(1);
        expect(mapsCalls).toBe(0);
    });

    it('keeps tracking when Maps fails', async () => {
        geocoding.calculateDistanceAndETA = async () => { throw new Error('no route'); };
        const result = await tracking.updateStaffLocation('u1', { latitude: 18.55, longitude: 73.88 });
        expect(result.straightLineKm).toBeGreaterThan(3);
    });
});
