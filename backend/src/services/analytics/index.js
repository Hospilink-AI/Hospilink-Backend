const cacheService = require('../cache.service');
const systemConfigService = require('../systemConfig.service');
const snapshotService = require('./snapshot.service');
const overview = require('./overview.service');
const marketplace = require('./marketplace.service');
const execution = require('./execution.service');
const money = require('./money.service');
const { SECTIONS, KPIS } = require('./catalogue');

const BUILDERS = { overview, marketplace, execution, money };

class AnalyticsService {
    get sections() {
        return Object.keys(BUILDERS);
    }

    getCatalogue() {
        return { sections: SECTIONS, kpis: KPIS };
    }



    // One section for a period. Cached briefly, since every figure is
    // computed from the live database.
    async getSection(section, period, filters) {
        // Crons may be off on some deployments; make sure yesterday's row exists
        snapshotService.ensureYesterday();

        const cacheSeconds = await systemConfigService.getEffective('analytics.liveCacheSeconds');
        const cacheKey = `analytics:${section}:${period.from}:${period.to}:${period.granularity}:${filters.staffRole || ''}:${filters.urgency || ''}:${(filters.city || '').toLowerCase()}`;

        if (cacheSeconds > 0) {
            const cached = await cacheService.get(cacheKey);
            if (cached) return cached;
        }

        const built = await BUILDERS[section].build(period, filters);
        const result = {
            section,
            period: {
                from: period.from,
                to: period.to,
                granularity: period.granularity,
                compareFrom: period.compareFrom,
                compareTo: period.compareTo
            },
            filters,
            generatedAt: new Date().toISOString(),
            ...built
        };

        if (cacheSeconds > 0) {
            await cacheService.set(cacheKey, result, cacheSeconds);
        }

        return result;
    }
}

module.exports = new AnalyticsService();
