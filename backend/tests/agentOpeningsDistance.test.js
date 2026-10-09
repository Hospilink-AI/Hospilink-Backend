// "More openings" distances come from batched Maps calls, and an opening
// Maps can't answer for gets an estimate instead of failing the list.
const mockCalls = [];
let mockFail = false;
jest.mock('axios', () => ({
    get: async (url, { params }) => {
        const count = params.destinations.split('|').length;
        mockCalls.push(count);
        if (mockFail) throw new Error('quota');
        return { data: { status: 'OK', rows: [{ elements: Array.from({ length: count }, (_, i) => (
            i === 0 ? { status: 'ZERO_RESULTS' } : { status: 'OK', distance: { value: 5000, text: '5 km' }, duration: { value: 600, text: '10 mins' } }
        )) }] } };
    }
}));

process.env.GOOGLE_MAPS_API_KEY = 'test-key';
jest.spyOn(console, 'error').mockImplementation(() => {});
const geocoding = require('../../agent/services/geocoding.service');

const points = (n) => Array.from({ length: n }, (_, i) => ({ id: i, latitude: 18.5 + i * 0.001, longitude: 73.8 }));

beforeEach(() => { mockCalls.length = 0; mockFail = false; });

describe('agent opening distances', () => {
    it('uses one Maps call per 25 openings instead of one each', async () => {
        const results = await geocoding.batchDistances(18.52, 73.85, points(60));
        expect(mockCalls).toEqual([25, 25, 10]);
        expect(results.size).toBe(60);
        expect(results.get(1)).toMatchObject({ distance: 5, durationText: '10 mins' });
    });

    it('estimates the openings Maps has no route for', async () => {
        const results = await geocoding.batchDistances(18.52, 73.85, points(3));
        expect(results.get(0).estimated).toBe(true);
        expect(results.get(1).estimated).toBeUndefined();
    });

    it('estimates everything when Maps fails, rather than throwing', async () => {
        mockFail = true;
        const results = await geocoding.batchDistances(18.52, 73.85, points(3));
        expect([...results.values()].every(r => r.estimated)).toBe(true);
    });

    it('is what the openings list uses', () => {
        const api = require('fs').readFileSync(require('path').join(__dirname, '../../agent/api.js'), 'utf8');
        expect(api).toContain('geocodingService.batchDistances(');
        expect(api).not.toMatch(/for \(const job of jobs\) \{\s+if \(job\.coordinates/);
    });
});
