const { asyncHandler, ValidationError, NotFoundError } = require('../middleware/error.middleware');
const mapsService = require('../services/maps.service');

// GET /api/maps/geocode?q= — address search (India)
exports.geocode = asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 3 || q.length > 200) {
        throw new ValidationError('Search text must be 3 to 200 characters');
    }
    const result = await mapsService.geocode(q);
    if (!result) throw new NotFoundError('No matching place found');
    res.status(200).json({ success: true, ...result });
});


// GET /api/maps/reverse-geocode?lat=&lng= — address for a dropped pin
exports.reverseGeocode = asyncHandler(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (req.query.lat === undefined || req.query.lng === undefined || req.query.lat === '' || req.query.lng === ''
        || !Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new ValidationError('lat and lng must be valid coordinates');
    }
    const result = await mapsService.reverseGeocode(lat, lng);
    if (!result) throw new NotFoundError('No address found for this point');
    res.status(200).json({ success: true, ...result });
});
