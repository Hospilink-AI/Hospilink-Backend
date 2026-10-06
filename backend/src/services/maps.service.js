const crypto = require('crypto');
const geocodingService = require('./geocoding.service');
const cacheService = require('./cache.service');
const { AppError } = require('../middleware/error.middleware');

const DAY_SECONDS = 24 * 60 * 60;
const NOT_FOUND_SECONDS = 60 * 60;

// Address search and pin lookups for the app's map screens, through the
// Google geocoding the backend already uses. Results are cached for a day;
// the cache key holds a hash, never the typed address.
class MapsService {
    // Returns { latitude, longitude, formattedAddress }, or null when nothing matches
    async geocode(query) {
        const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
        const key = `maps:geocode:${crypto.createHash('sha1').update(normalized).digest('hex')}`;

        const cached = await cacheService.get(key);
        if (cached) return cached.found ? cached.result : null;

        let result = null;
        try {
            const { latitude, longitude, formattedAddress } = await geocodingService.geocodeAddress(query.trim());
            result = { latitude, longitude, formattedAddress };
        } catch (error) {
            if (!this._isNoMatch(error)) throw this._unavailable();
        }

        await cacheService.set(key, { found: !!result, result }, result ? DAY_SECONDS : NOT_FOUND_SECONDS);
        return result;
    }

    // Returns { formattedAddress, street, city, state, pincode }, or null
    async reverseGeocode(latitude, longitude) {
        const key = `maps:reverse:${latitude.toFixed(4)}:${longitude.toFixed(4)}`;

        const cached = await cacheService.get(key);
        if (cached) return cached.found ? cached.result : null;

        let result = null;
        try {
            const { formattedAddress, components } = await geocodingService.reverseGeocode(latitude, longitude);
            result = { formattedAddress, ...this.addressParts(components) };
        } catch (error) {
            if (!this._isNoMatch(error)) throw this._unavailable();
        }

        await cacheService.set(key, { found: !!result, result }, result ? DAY_SECONDS : NOT_FOUND_SECONDS);
        return result;
    }

    addressParts(components = []) {
        const find = (...types) => {
            for (const type of types) {
                const part = components.find(c => (c.types || []).includes(type));
                if (part) return part.long_name;
            }
            return null;
        };
        const streetNumber = find('street_number');
        const route = find('route');
        const street = [streetNumber, route].filter(Boolean).join(' ')
            || find('sublocality_level_1', 'sublocality', 'neighborhood');

        return {
            street: street || null,
            city: find('locality', 'administrative_area_level_2'),
            state: find('administrative_area_level_1'),
            pincode: find('postal_code')
        };
    }

    _isNoMatch(error) {
        return /ZERO_RESULTS/.test(error?.message || '');
    }

    _unavailable() {
        return new AppError('Map search is unavailable right now. Please try again shortly.', 503);
    }
}

module.exports = new MapsService();
