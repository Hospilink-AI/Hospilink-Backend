// Snaps a point to a grid of roughly `km` so a doctor's home or live position
// can't be pinpointed. 0 leaves it exact.
function approximatePoint(latitude, longitude, km) {
    if (!km || typeof latitude !== 'number' || typeof longitude !== 'number') {
        return { latitude, longitude };
    }
    const snap = (value, step) => Number((Math.round(value / step) * step).toFixed(5));
    const snappedLat = snap(latitude, km / 111);
    // Sized from the snapped latitude, so every point in a band shares one grid
    const lngStep = km / (111 * Math.max(Math.cos(snappedLat * Math.PI / 180), 0.01));
    return { latitude: snappedLat, longitude: snap(longitude, lngStep) };
}

module.exports = { approximatePoint };
