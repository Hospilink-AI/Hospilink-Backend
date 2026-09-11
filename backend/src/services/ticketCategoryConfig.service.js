const systemConfigService = require('./systemConfig.service');
const { NotFoundError } = require('../middleware/error.middleware');

// The per-category route table (spec §03/§07) lives as SystemConfig rows
// rather than its own model — "editable without a deploy" (§07/§15) is
// exactly what SystemConfig's versioned key/value store already gives the
// interview-config screen, so a category's route/SLA/evidence rules change
// the same way any other admin setting does, with the same audit trail via
// createdBy/effectiveFrom.
function cacheKeyFor(category) {
    return `ticket.category.${category}`;
}

class TicketCategoryConfigService {
    // Returns { resolutionClass, queue, evidenceRequired }. Throws if the
    // category was never seeded — that's a deploy/seed bug, not a user
    // error, so callers (Ticket.js's pre-validate hook) should let it
    // surface rather than silently defaulting a category to some class.
    async getByCategory(category) {
        const config = await systemConfigService.getEffective(cacheKeyFor(category));
        if (!config) {
            throw new NotFoundError(`No category config seeded for "${category}" — run scripts/seedTicketCategoryConfig.js`);
        }
        return config;
    }

    async setForCategory(category, { resolutionClass, queue, evidenceRequired = [] }, { effectiveFrom, createdBy } = {}) {
        return systemConfigService.setValue(
            cacheKeyFor(category),
            { resolutionClass, queue, evidenceRequired },
            { effectiveFrom, createdBy }
        );
    }
}

module.exports = new TicketCategoryConfigService();
