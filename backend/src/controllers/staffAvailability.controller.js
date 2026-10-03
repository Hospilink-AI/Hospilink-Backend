const { asyncHandler } = require('../middleware/error.middleware');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');
const staffAvailabilityService = require('../services/staffAvailability.service');

// GET /api/staff/availability?from=&to= — pattern, single days, and each day resolved
exports.getAvailability = asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    const availability = await staffAvailabilityService.getForStaff(req.user.id, from, to);
    res.status(200).json({ success: true, ...availability });
});


// PUT /api/staff/availability/weekly
exports.setWeekly = asyncHandler(async (req, res) => {
    const availability = await staffAvailabilityService.setWeekly(req.user.id, req.body.weekly);
    activityLogEmitter.logAction(ACTIVITY_ACTIONS.AVAILABILITY_CHANGED, req, { type: 'user', id: req.user._id || req.user.id, name: req.user.name }, { change: 'weekly_pattern', days: req.body.weekly.map(w => w.day) }).catch(() => {});
    res.status(200).json({ success: true, message: 'Weekly availability saved', ...availability });
});


// PUT /api/staff/availability/dates
exports.setDates = asyncHandler(async (req, res) => {
    const availability = await staffAvailabilityService.setDates(req.user.id, req.body.dates);
    activityLogEmitter.logAction(ACTIVITY_ACTIONS.AVAILABILITY_CHANGED, req, { type: 'user', id: req.user._id || req.user.id, name: req.user.name }, { change: 'dates', dates: req.body.dates.map(d => `${d.date}:${d.status}`) }).catch(() => {});
    res.status(200).json({ success: true, message: 'Availability updated', ...availability });
});
