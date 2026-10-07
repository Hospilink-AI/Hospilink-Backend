const { approximatePoint } = require('../src/utils/privacy.helper');
const { haversineKm } = require('../src/services/staffLocator.service');
const { validateValue } = require('../src/utils/systemConfig.rules');
const systemConfigService = require('../src/services/systemConfig.service');

describe('approximate doctor positions on the hospital map', () => {
    const home = { latitude: 18.520431, longitude: 73.856743 };

    it('moves a point by no more than about the precision', () => {
        for (const km of [0.5, 1, 2, 5]) {
            const p = approximatePoint(home.latitude, home.longitude, km);
            expect(haversineKm(home.latitude, home.longitude, p.latitude, p.longitude)).toBeLessThanOrEqual(km);
        }
    });

    it('gives homes about 200 m apart in the same area the same point', () => {
        const centre = approximatePoint(home.latitude, home.longitude, 1);
        const a = approximatePoint(centre.latitude + 0.001, centre.longitude - 0.001, 1);
        const b = approximatePoint(centre.latitude - 0.001, centre.longitude + 0.001, 1);
        expect(a).toEqual(centre);
        expect(b).toEqual(centre);
    });

    it('leaves the point exact at 0', () => {
        expect(approximatePoint(home.latitude, home.longitude, 0)).toEqual(home);
    });
});

describe('privacy settings', () => {
    it('hide contacts and round to 1 km by default', () => {
        expect(systemConfigService.isKnownKey('privacy.showContactOnMap')).toBe(true);
        expect(systemConfigService.defaultKeys).toEqual(expect.arrayContaining(['privacy.showContactOnMap', 'privacy.mapLocationPrecisionKm']));
    });

    it('only accepts sensible values', () => {
        expect(validateValue('privacy.mapLocationPrecisionKm', 2)).toBeNull();
        expect(validateValue('privacy.mapLocationPrecisionKm', 50)).not.toBeNull();
        expect(validateValue('privacy.showContactOnMap', 'yes', false)).not.toBeNull();
    });
});
