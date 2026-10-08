// The hospital app reads the price rules and the RMO market rates from the
// server, and admins can change the market rates without a release.
jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
jest.mock('../src/services/cache.service', () => ({
    acquireLock: async () => true, releaseLock: async () => true, get: async () => null, set: async () => true, del: async () => true
}));

const systemConfigService = require('../src/services/systemConfig.service');
const { pricingForHospitals } = require('../src/utils/dutyPricing');
const router = require('../src/routes/duty.routes');

describe('pricing for hospitals', () => {
    it('returns the rules and the default market rates', async () => {
        const keys = ['pricing.rmoCasualtyTotal', 'pricing.rmoCasualtyHours', 'pricing.rmoIcuTotal', 'pricing.rmoIcuHours'];
        const defaults = { 'pricing.rmoCasualtyTotal': 1400, 'pricing.rmoCasualtyHours': 8, 'pricing.rmoIcuTotal': 1800, 'pricing.rmoIcuHours': 8 };
        systemConfigService.getManyEffective = async (asked) => {
            expect(asked.sort()).toEqual(keys.sort());
            return defaults;
        };
        expect(await pricingForHospitals()).toEqual({
            minTotal: 499,
            maxTotal: 9999,
            minHours: 3,
            maxHours: 24,
            recommendations: { rmo: { casualty: { total: 1400, hours: 8 }, icu: { total: 1800, hours: 8 } } }
        });
    });

    it('registers the market rates as known settings with the old hard-coded values', () => {
        for (const [key, value] of Object.entries({ 'pricing.rmoCasualtyTotal': 1400, 'pricing.rmoCasualtyHours': 8, 'pricing.rmoIcuTotal': 1800, 'pricing.rmoIcuHours': 8 })) {
            expect(systemConfigService.isKnownKey(key)).toBe(true);
            expect(systemConfigService.defaultKeys).toContain(key);
            expect(value).toBeGreaterThan(0);
        }
    });

    it('refuses market rates outside the duty price rules', async () => {
        systemConfigService.getManyEffective = async (keys) => Object.fromEntries(keys.map(k => [k, 8]));
        expect(await systemConfigService.validateUpdate('pricing.rmoIcuTotal', 300)).toBeTruthy();
        expect(await systemConfigService.validateUpdate('pricing.rmoIcuTotal', 12000)).toBeTruthy();
        expect(await systemConfigService.validateUpdate('pricing.rmoIcuHours', 2)).toBeTruthy();
        expect(await systemConfigService.validateUpdate('pricing.rmoIcuTotal', 2000)).toBeFalsy();
    });

    it('is served at GET /hospitals/current/pricing', () => {
        const layer = router.stack.find(l => l.route && l.route.path === '/hospitals/current/pricing');
        expect(layer.route.methods.get).toBe(true);
    });
});
