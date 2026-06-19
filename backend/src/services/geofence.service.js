const locationBasedStaffService = require('./locationBasedStaff.service');

// Radius (in km) within which a staff member is considered "at the hospital"
// for the purposes of the Start OTP handshake. Default 0.1km = 100m.
const GEOFENCE_RADIUS_KM = parseFloat(process.env.DUTY_GEOFENCE_RADIUS_KM) || 0.1;

function isWithinGeofence(staffLat, staffLng, hospitalLat, hospitalLng) {
    const distanceKm = locationBasedStaffService.haversineDistance(staffLat, staffLng, hospitalLat, hospitalLng);
    return distanceKm <= GEOFENCE_RADIUS_KM;
}

module.exports = { isWithinGeofence, GEOFENCE_RADIUS_KM };
