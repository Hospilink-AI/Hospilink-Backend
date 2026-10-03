const { asyncHandler } = require('../middleware/error.middleware');
const analyticsService = require('../services/analytics');
const analyticsExport = require('../services/analytics/export');
const activityLogEmitter = require('../services/activityLogEmitter');
const { ACTIVITY_ACTIONS } = require('../utils/activityLog.constants');

// GET /api/admin/analytics/catalogue — every KPI with its definition
exports.getCatalogue = asyncHandler(async (req, res) => {
    res.status(200).json({ success: true, ...analyticsService.getCatalogue() });
});


// GET /api/admin/analytics/export?section=&format=csv|xlsx — one section as a file
exports.exportSection = asyncHandler(async (req, res) => {
    const { period, filters, section, format } = req.analyticsQuery;
    const result = await analyticsService.getSection(section, period, filters);
    const fileName = `hospilink-${section}-${period.from}-to-${period.to}.${format}`;
    activityLogEmitter.logAction(ACTIVITY_ACTIONS.DATA_EXPORTED, req, { type: 'export', id: `analytics-${section}`, name: `Analytics: ${section}` }, { format, from: period.from, to: period.to, filters })
        .catch(() => {});

    if (format === 'xlsx') {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        return res.status(200).send(analyticsExport.toXlsx(result));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.status(200).send(analyticsExport.toCsv(result));
});


// GET /api/admin/analytics/:section — tiles and charts for one section
exports.getSection = asyncHandler(async (req, res) => {
    const { period, filters } = req.analyticsQuery;
    const result = await analyticsService.getSection(req.params.section, period, filters);
    res.status(200).json({ success: true, ...result });
});
