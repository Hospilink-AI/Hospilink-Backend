// Admin: platform settings (interview, auto-relist, calendar)
// Methods of AdminService; mixed into the class in ../admin.service.js, so `this` is the service.
const cacheService = require('../cache.service');
const SystemConfigService = require('../systemConfig.service');
const { UnprocessableEntityError } = require('../../middleware/error.middleware');
const { PLATFORM_SETTING_PREFIXES } = require('./helpers');

module.exports = {
    // GET /api/admin/interview-config — every setting's current effective
    // value plus its full version history.
    async getInterviewConfig() {
        const keys = SystemConfigService.defaultKeys;
        const [effective, historyEntries] = await Promise.all([
            SystemConfigService.getAllEffective(),
            Promise.all(keys.map(key => SystemConfigService.getHistory(key)))
        ]);
        return keys.map((key, i) => ({ key, value: effective[key], history: historyEntries[i] }));
    },

    // PATCH /api/admin/interview-config — inserts a new version, never edits
    // history in place. effectiveFrom defaults to now inside SystemConfigService.
    async updateInterviewConfig(key, value, effectiveFrom, adminUserId) {
        if (!SystemConfigService.isKnownKey(key)) {
            throw new UnprocessableEntityError(`Unknown config key: ${key}`);
        }
        const invalid = await SystemConfigService.validateUpdate(key, value);
        if (invalid) {
            throw new UnprocessableEntityError(invalid);
        }
        return SystemConfigService.setValue(key, value, {
            effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : undefined,
            createdBy: adminUserId
        });
    },

    // GET /api/admin/auto-relist/config — same shape as getInterviewConfig,
    // scoped to just the 'autoRelist.*' keys (SystemConfig is one shared
    // store; this filters rather than duplicating the read logic).
    async getAutoRelistConfig() {
        const keys = SystemConfigService.defaultKeys.filter(key => key.startsWith('autoRelist.'));
        const [effective, historyEntries] = await Promise.all([
            SystemConfigService.getManyEffective(keys),
            Promise.all(keys.map(key => SystemConfigService.getHistory(key)))
        ]);
        return keys.map((key, i) => ({ key, value: effective[key], history: historyEntries[i] }));
    },

    // PATCH /api/admin/auto-relist/config — Super Admin only (capability
    // 'autoRelist.config.manage' is granted to no other sub-role). Rejects
    // any key outside the autoRelist.* namespace even though it's
    // technically a known SystemConfig key — this endpoint is not a
    // backdoor into every other domain's settings.
    async updateAutoRelistConfig(key, value, effectiveFrom, adminUserId) {
        if (!key.startsWith('autoRelist.') || !SystemConfigService.isKnownKey(key)) {
            throw new UnprocessableEntityError(`Unknown auto-relist config key: ${key}`);
        }
        const invalid = await SystemConfigService.validateUpdate(key, value);
        if (invalid) {
            throw new UnprocessableEntityError(invalid);
        }
        return SystemConfigService.setValue(key, value, {
            effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : undefined,
            createdBy: adminUserId
        });
    },

    // GET /api/admin/calendar/config — same shape as getAutoRelistConfig,
    // scoped to the 'calendar.*' keys
    async getCalendarConfig() {
        const keys = SystemConfigService.defaultKeys.filter(key => key.startsWith('calendar.'));
        const [effective, historyEntries] = await Promise.all([
            SystemConfigService.getManyEffective(keys),
            Promise.all(keys.map(key => SystemConfigService.getHistory(key)))
        ]);
        return keys.map((key, i) => ({ key, value: effective[key], history: historyEntries[i] }));
    },

    // GET /api/admin/settings — the staged offer, analytics and notification
    // settings, which had no admin screen of their own. Same shape as the
    // calendar config.
    async getPlatformSettings() {
        const keys = SystemConfigService.defaultKeys.filter(key => PLATFORM_SETTING_PREFIXES.some(p => key.startsWith(p)));
        const [effective, historyEntries] = await Promise.all([
            SystemConfigService.getManyEffective(keys),
            Promise.all(keys.map(key => SystemConfigService.getHistory(key)))
        ]);
        return keys.map((key, i) => ({ key, value: effective[key], history: historyEntries[i] }));
    },

    // PATCH /api/admin/settings — Super Admin only ('settings.manage' is
    // granted to no other sub-role). Only the prefixes above.
    async updatePlatformSetting(key, value, effectiveFrom, adminUserId) {
        if (!PLATFORM_SETTING_PREFIXES.some(p => key.startsWith(p)) || !SystemConfigService.isKnownKey(key)) {
            throw new UnprocessableEntityError(`Unknown setting: ${key}`);
        }
        const invalid = await SystemConfigService.validateUpdate(key, value);
        if (invalid) {
            throw new UnprocessableEntityError(invalid);
        }
        const saved = await SystemConfigService.setValue(key, value, {
            effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : undefined,
            createdBy: adminUserId
        });
        // Hospital maps are cached for 2 minutes; show privacy changes straight away
        if (key.startsWith('privacy.')) {
            await cacheService.invalidateAllNearbyStaff();
        }
        return saved;
    },

    // PATCH /api/admin/calendar/config — Super Admin only ('calendar.config.manage'
    // is granted to no other sub-role). Only calendar.* keys.
    async updateCalendarConfig(key, value, effectiveFrom, adminUserId) {
        if (!key.startsWith('calendar.') || !SystemConfigService.isKnownKey(key)) {
            throw new UnprocessableEntityError(`Unknown calendar config key: ${key}`);
        }
        const invalid = await SystemConfigService.validateUpdate(key, value);
        if (invalid) {
            throw new UnprocessableEntityError(invalid);
        }
        return SystemConfigService.setValue(key, value, {
            effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : undefined,
            createdBy: adminUserId
        });
    }
};
