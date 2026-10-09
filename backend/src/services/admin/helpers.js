// Shared helpers for admin.service.js and its method groups in ./
const escapeRegex = require('../../utils/escapeRegex');

// Settings groups edited through /api/admin/settings
const PLATFORM_SETTING_PREFIXES = ['offer.', 'analytics.', 'notifications.', 'privacy.', 'pricing.'];

module.exports = { escapeRegex, PLATFORM_SETTING_PREFIXES };
