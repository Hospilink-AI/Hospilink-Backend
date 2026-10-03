const { asyncHandler } = require('../middleware/error.middleware');
const analyticsService = require('../services/analytics');

// GET /api/admin/analytics/catalogue — every KPI with its definition
exports.getCatalogue = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, ...analyticsService.getCatalogue() });
});


// GET /api/admin/analytics/:section — tiles and charts for one section
exports.getSection = asyncHandler(async (req, res) => {
    const { period, filters } = req.analyticsQuery;
    const result = await analyticsService.getSection(req.params.section, period, filters);
    res.status(200).json({ success: true, ...result });
});
