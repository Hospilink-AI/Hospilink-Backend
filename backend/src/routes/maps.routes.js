const express = require('express');
const router = express.Router();
const mapsController = require('../controllers/maps.controller');
const { protect } = require('../middleware/auth.middleware');
const { mapsRateLimit } = require('../middleware/rateLimit.middleware');

// Any signed-in user (doctor, hospital or admin)
router.use(protect);
router.use(mapsRateLimit);

router.get('/geocode', mapsController.geocode);
router.get('/reverse-geocode', mapsController.reverseGeocode);

module.exports = router;
