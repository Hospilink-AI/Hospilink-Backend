jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockCleared = [];
jest.mock('../src/services/cache.service', () => ({
    invalidatePattern: async (p) => { mockCleared.push(p); return true; },
    get: async () => null, set: async () => true, del: async () => true
}));
jest.mock('../src/services/systemConfig.service', () => ({
    isKnownKey: () => true,
    validateUpdate: async () => null,
    setValue: async (key, value) => ({ key, value })
}));

const adminService = require('../src/services/admin.service');

beforeEach(() => { mockCleared.length = 0; });

describe('saving platform settings', () => {
    it('clears the hospital map cache when a privacy setting changes', async () => {
        await adminService.updatePlatformSetting('privacy.showContactOnMap', true, null, 'a1');
        await adminService.updatePlatformSetting('privacy.mapLocationPrecisionKm', 2, null, 'a1');
        expect(mockCleared).toEqual(['nearby:staff:*', 'nearby:staff:*']);
    });

    it('leaves the map cache alone for other settings', async () => {
        await adminService.updatePlatformSetting('offer.startRadiusKm', 25, null, 'a1');
        expect(mockCleared).toEqual([]);
    });
});
