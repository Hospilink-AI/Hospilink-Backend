const axios = require('axios');
const redisClient = require('../config/redis');

class GeocodingService {
    constructor() {
        // Google Maps APIs
        this.geocodingUrl = process.env.GOOGLE_MAPS_GEOCODING_URL || 'https://maps.googleapis.com/maps/api/geocode/json';
        this.distanceMatrixUrl = process.env.GOOGLE_MAPS_DISTANCE_MATRIX_URL || 'https://maps.googleapis.com/maps/api/distancematrix/json';
        this.directionsUrl = process.env.GOOGLE_MAPS_DIRECTIONS_URL || 'https://maps.googleapis.com/maps/api/directions/json';

        this.apiKey = process.env.GOOGLE_MAPS_API_KEY;



        if (!this.apiKey) {
            console.warn('Google Maps API key not found in environment variables');
        }
    }


    // Geocode address to coordinates
    async geocodeAddress(address) {
        try {
            if (!this.apiKey) {
                throw new Error('Google Maps API key is required for geocoding');
            }

            console.log('Geocoding address:', address);

            const response = await axios.get(this.geocodingUrl, {
                params: {
                    address: address,
                    key: this.apiKey,
                    region: 'in', // India region
                    components: 'country:IN'
                },
                timeout: 10000
            });

            if (response.data.status === 'OK' && response.data.results.length > 0) {
                const result = response.data.results[0];
                const { lat, lng } = result.geometry.location;

                const coords = { 
                    latitude: parseFloat(lat), 
                    longitude: parseFloat(lng),
                    formattedAddress: result.formatted_address
                };

                console.log('Geocoding successful:', coords);
                return coords;
            }

            console.log('Geocoding failed:', response.data.status);
            throw new Error(`Geocoding failed: ${response.data.status}`);

        } catch (error) {
            console.error('Geocoding error:', error.message);

            // If API quota exceeded, try with simplified address
            if (error.response?.data?.status === 'OVER_QUERY_LIMIT') {
                console.log('Query limit reached, trying with simplified address...');
                return await this.geocodeWithRetry(address);
            }

            throw error;
        }
    }



    // Retry geocoding with simplified address
    async geocodeWithRetry(address) {
        try {
            // Extract just the city name for retry
            const simplifiedAddress = address.split(',')[0].trim();
            console.log('Retrying with simplified address:', simplifiedAddress);

            const response = await axios.get(this.geocodingUrl, {
                params: {
                    address: simplifiedAddress,
                    key: this.apiKey,
                    region: 'in'
                },
                timeout: 5000
            });

            if (response.data.status === 'OK' && response.data.results.length > 0) {
                const result = response.data.results[0];
                const { lat, lng } = result.geometry.location;

                return { 
                    latitude: parseFloat(lat), 
                    longitude: parseFloat(lng),
                    formattedAddress: result.formatted_address
                };
            }

            throw new Error('Retry geocoding also failed');
        } catch (error) {
            console.error('Retry geocoding failed:', error.message);
            throw error;
        }
    }



    // Calculate distance and ETA using Google Maps Distance Matrix API
    async calculateDistanceAndETA(originLat, originLng, destLat, destLng) {
        console.log('Starting distance calculation:', {
            origin: `${originLat}, ${originLng}`,
            destination: `${destLat}, ${destLng}`
        });

        try {
            if (!this.apiKey) {
                throw new Error('Google Maps API key is required for distance calculation');
            }

            console.log('Using Google Maps Distance Matrix API...');
            const requestParams = {
                origins: `${originLat},${originLng}`,
                destinations: `${destLat},${destLng}`,
                key: this.apiKey,
                mode: 'driving',
                region: 'in',
                traffic_model: 'best_guess',
                departure_time: 'now'  // Current time for traffic-aware calculations
            };

            console.log('Request URL:', this.distanceMatrixUrl);
            console.log('Request params:', {
                ...requestParams,
                key: this.apiKey ? 'API_KEY_PRESENT' : 'NO_API_KEY'
            });

            // Build the full URL for debugging
            const fullUrl = `${this.distanceMatrixUrl}?origins=${encodeURIComponent(requestParams.origins)}&destinations=${encodeURIComponent(requestParams.destinations)}&key=${requestParams.key}&mode=${requestParams.mode}&region=${requestParams.region}&traffic_model=${requestParams.traffic_model}&departure_time=${requestParams.departure_time}`;
            console.log('Full request URL:', fullUrl);

            const response = await axios.get(this.distanceMatrixUrl, {
                params: requestParams,
                timeout: 10000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'HospiLink-Backend/1.0'
                }
            });

            console.log('Response status:', response.status);
            console.log('Response data:', JSON.stringify(response.data, null, 2));

            if (response.data.status === 'OK' && 
                response.data.rows[0].elements[0].status === 'OK') {

                const element = response.data.rows[0].elements[0];
                const distance = element.distance.value / 1000; // Convert to km
                const duration = element.duration.value / 60; // Convert to minutes

                const result = {
                    distance: Math.round(distance * 100) / 100, // Round to 2 decimal places
                    duration: Math.round(duration),
                    distanceText: element.distance.text,
                    durationText: element.duration.text,
                    source: 'google_maps_api'
                };

                console.log('Distance calculated using Google Maps API:', result);
                return result;
            }

            console.log('Google Maps API returned non-OK status:', response.data.status);
            console.log('Full response:', JSON.stringify(response.data, null, 2));
            throw new Error(`Google Maps Distance Matrix API failed: ${response.data.status}`);

        } catch (error) {
            console.error('Google Maps Distance Matrix API error:', error.message);
            if (error.response) {
                console.error('Error response status:', error.response.status);
                console.error('Error response data:', JSON.stringify(error.response.data, null, 2));
                console.error('Error response headers:', error.response.headers);
            } else if (error.request) {
                console.error('No response received:', error.request);
            } else {
                console.error('Request setup error:', error.message);
            }
            
            throw new Error(`Google Maps Distance Matrix API error: ${error.message}`);
        }
    }



    // Get directions between two points using Google Maps Directions API
    async getDirections(originLat, originLng, destLat, destLng) {
        try {
            if (!this.apiKey) {

                throw new Error('Google Maps API key is required for directions');
            }

            const response = await axios.get(this.directionsUrl, {
                params: {
                    origin: `${originLat},${originLng}`,
                    destination: `${destLat},${destLng}`,
                    key: this.apiKey,
                    mode: 'driving',
                    region: 'in'
                },
                timeout: 10000
            });


            if (response.data.status === 'OK' && response.data.routes.length > 0) {
                const route = response.data.routes[0];
                const leg = route.legs[0];

                return {
                    // Keep overview for fallback/high-level view
                    overviewPolyline: route.overview_polyline.points,
                    
                    // Add detailed step polylines for accurate road following
                    stepPolylines: leg.steps.map(step => step.polyline.points),
                    
                    // Keep existing fields
                    distance: leg.distance.value / 1000,
                    duration: leg.duration.value / 60,
                    distanceText: leg.distance.text,
                    durationText: leg.duration.text,
                    steps: leg.steps.map(step => ({
                        instruction: step.html_instructions.replace(/<[^>]*>/g, ''),
                        distance: step.distance.value / 1000,
                        duration: step.duration.value / 60,
                        startLocation: step.start_location,
                        endLocation: step.end_location,
                        polyline: step.polyline.points
                    }))
                };
            }
            throw new Error(`Directions API failed: ${response.data.status}`);

        } catch (error) {
            console.error('Directions API error:', error.message);
            throw error;
        }
    }



    // Validate coordinates
    validateCoordinates(lat, lng) {
        if (!lat || !lng || lat === null || lng === null) {
            throw new Error('Valid coordinates are required');
        }

        if (typeof lat !== 'number' || typeof lng !== 'number') {
            throw new Error('Coordinates must be numbers');
        }

        if (lat < -90 || lat > 90) {
            throw new Error('Latitude must be between -90 and 90');
        }

        if (lng < -180 || lng > 180) {
            throw new Error('Longitude must be between -180 and 180');
        }

        // Optional: Check if coordinates are in India
        if (lat < 6 || lat > 38 || lng < 68 || lng > 98) {
            console.warn('Coordinates may be outside India:', lat, lng);
        }

        return true;
    }



    // Batch geocode multiple addresses
    async batchGeocode(addresses) {
        const results = [];

        for (const address of addresses) {
            try {
                const result = await this.geocodeAddress(address);
                results.push({ address, success: true, data: result });
            } catch (error) {
                results.push({ address, success: false, error: error.message });
            }
        }

        return results;
    }



    // Reverse geocode coordinates to address
    async reverseGeocode(lat, lng) {
        try {
            if (!this.apiKey) {
                throw new Error('Google Maps API key is required for reverse geocoding');
            }

            const response = await axios.get(this.geocodingUrl, {
                params: {
                    latlng: `${lat},${lng}`,
                    key: this.apiKey,
                    region: 'in'
                },
                timeout: 10000
            });

            if (response.data.status === 'OK' && response.data.results.length > 0) {
                const result = response.data.results[0];
                return {
                    formattedAddress: result.formatted_address,
                    components: result.address_components,
                    placeId: result.place_id
                };
            }

            throw new Error(`Reverse geocoding failed: ${response.data.status}`);

        } catch (error) {
            console.error('Reverse geocoding error:', error.message);
            throw error;
        }
    }


    
    // Cache distance calculations to reduce API calls
    async getCachedDistance(staffLat, staffLng, hospitalLat, hospitalLng) {
        const cacheKey = `distance:${staffLat.toFixed(4)}:${staffLng.toFixed(4)}:${hospitalLat.toFixed(4)}:${hospitalLng.toFixed(4)}`;
        
        try {
            const redis = await redisClient.getClientAsync();
            
            // Try to get cached result
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.log('Using cached distance for:', cacheKey);
                return JSON.parse(cached);
            }
            
            // Calculate and cache for 5 minutes
            const distanceResult = await this.calculateDistanceAndETA(
                staffLat, staffLng, hospitalLat, hospitalLng
            );
            
            await redis.setex(cacheKey, 300, JSON.stringify(distanceResult));
            console.log('Cached distance for:', cacheKey);
            return distanceResult;
        } catch (error) {
            console.error('Error in distance caching:', error);
            // Fallback to direct calculation
            return await this.calculateDistanceAndETA(
                staffLat, staffLng, hospitalLat, hospitalLng
            );
        }
    }
}

module.exports = new GeocodingService();