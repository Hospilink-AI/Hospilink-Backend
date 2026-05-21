/**
 * Geocoding Service — agent-local copy
 * Copied from src/services/geocoding.service.js to make agent self-contained.
 * Does NOT import Redis from src/ — uses axios directly with no caching
 * (agent has its own in-memory cache layer).
 */
const axios = require('axios');

class GeocodingService {
    constructor() {
        this.geocodingUrl = process.env.GOOGLE_MAPS_GEOCODING_URL || 'https://maps.googleapis.com/maps/api/geocode/json';
        this.distanceMatrixUrl = process.env.GOOGLE_MAPS_DISTANCE_MATRIX_URL || 'https://maps.googleapis.com/maps/api/distancematrix/json';
        this.directionsUrl = process.env.GOOGLE_MAPS_DIRECTIONS_URL || 'https://maps.googleapis.com/maps/api/directions/json';
        this.apiKey = process.env.GOOGLE_MAPS_API_KEY;

        if (!this.apiKey) {
            console.warn('Google Maps API key not found in environment variables');
        }
    }

    async geocodeAddress(address) {
        try {
            if (!this.apiKey) throw new Error('Google Maps API key is required for geocoding');

            const response = await axios.get(this.geocodingUrl, {
                params: { address, key: this.apiKey, region: 'in', components: 'country:IN' },
                timeout: 10000
            });

            if (response.data.status === 'OK' && response.data.results.length > 0) {
                const result = response.data.results[0];
                const { lat, lng } = result.geometry.location;
                return { latitude: parseFloat(lat), longitude: parseFloat(lng), formattedAddress: result.formatted_address };
            }
            throw new Error(`Geocoding failed: ${response.data.status}`);
        } catch (error) {
            console.error('Geocoding error:', error.message);
            throw error;
        }
    }

    async calculateDistanceAndETA(originLat, originLng, destLat, destLng) {
        try {
            if (!this.apiKey) throw new Error('Google Maps API key is required for distance calculation');

            const response = await axios.get(this.distanceMatrixUrl, {
                params: {
                    origins: `${originLat},${originLng}`,
                    destinations: `${destLat},${destLng}`,
                    key: this.apiKey,
                    mode: 'driving',
                    region: 'in',
                    traffic_model: 'best_guess',
                    departure_time: 'now'
                },
                timeout: 10000
            });

            if (response.data.status === 'OK' && response.data.rows[0].elements[0].status === 'OK') {
                const element = response.data.rows[0].elements[0];
                return {
                    distance: Math.round((element.distance.value / 1000) * 100) / 100,
                    duration: Math.round(element.duration.value / 60),
                    distanceText: element.distance.text,
                    durationText: element.duration.text
                };
            }
            throw new Error(`Distance Matrix API failed: ${response.data.status}`);
        } catch (error) {
            console.error('Distance calculation error:', error.message);
            throw error;
        }
    }

    // Haversine fallback for when Google Maps API is unavailable
    calculateDistanceHaversine(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return { distance: R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) };
    }

    validateCoordinates(lat, lng) {
        if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error('Coordinates must be numbers');
        if (lat < -90 || lat > 90) throw new Error('Latitude must be between -90 and 90');
        if (lng < -180 || lng > 180) throw new Error('Longitude must be between -180 and 180');
        return true;
    }
}

module.exports = new GeocodingService();
