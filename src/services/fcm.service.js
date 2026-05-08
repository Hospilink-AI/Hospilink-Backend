const admin = require('firebase-admin');
const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * FCM Service
 * Handles Firebase Cloud Messaging for push notifications
 */
class FCMService {
    constructor() {
        this.initialized = false;
        this.initializeFirebase();
    }

    /**
     * Initialize Firebase Admin SDK
     */
    initializeFirebase() {
        try {
            // Check if already initialized
            if (admin.apps.length > 0) {
                this.initialized = true;
                logger.info('Firebase Admin already initialized');
                return;
            }

            // Check for required environment variables
            if (!process.env.FCM_PROJECT_ID || !process.env.FCM_CLIENT_EMAIL || !process.env.FCM_PRIVATE_KEY) {
                logger.warn('FCM credentials not configured - push notifications disabled');
                return;
            }

            // Initialize Firebase Admin
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FCM_PROJECT_ID,
                    clientEmail: process.env.FCM_CLIENT_EMAIL,
                    privateKey: process.env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n')
                })
            });

            this.initialized = true;
            logger.info('Firebase Admin initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize Firebase Admin:', error.message);
            this.initialized = false;
        }
    }

    /**
     * Check if FCM is initialized
     * @returns {boolean}
     */
    isInitialized() {
        return this.initialized;
    }

    /**
     * Send push notification to a single user (all their devices)
     * @param {string} userId - User ID
     * @param {string} title - Notification title
     * @param {string} body - Notification body
     * @param {Object} data - Additional data payload
     * @returns {Promise<Object>} Send result
     */
    async sendToUser(userId, title, body, data = {}) {
        try {
            if (!this.initialized) {
                logger.warn('FCM not initialized, skipping push notification');
                return { success: false, reason: 'FCM not initialized' };
            }

            // Get user's FCM tokens
            const user = await User.findById(userId).select('fcmTokens');
            if (!user || !user.fcmTokens || user.fcmTokens.length === 0) {
                logger.info(`No FCM tokens found for user ${userId}`);
                return { success: false, reason: 'No FCM tokens' };
            }

            const tokens = user.fcmTokens.map(t => t.token);
            return await this.sendMulticast(tokens, title, body, data, userId);
        } catch (error) {
            logger.error(`FCM sendToUser error for ${userId}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Send push notification to multiple users
     * @param {string[]} userIds - Array of user IDs
     * @param {string} title - Notification title
     * @param {string} body - Notification body
     * @param {Object} data - Additional data payload
     * @returns {Promise<Object>} Send result
     */
    async sendToUsers(userIds, title, body, data = {}) {
        try {
            if (!this.initialized) {
                logger.warn('FCM not initialized, skipping push notifications');
                return { success: false, reason: 'FCM not initialized' };
            }

            // Get all users with FCM tokens
            const users = await User.find({
                _id: { $in: userIds },
                'fcmTokens.0': { $exists: true }
            }).select('_id fcmTokens');

            if (users.length === 0) {
                logger.info('No users with FCM tokens found');
                return { success: false, reason: 'No FCM tokens' };
            }

            // Collect all tokens
            const allTokens = users.flatMap(u => u.fcmTokens.map(t => t.token));
            
            if (allTokens.length === 0) {
                return { success: false, reason: 'No FCM tokens' };
            }

            // FCM multicast supports max 500 tokens per call
            const chunks = [];
            for (let i = 0; i < allTokens.length; i += 500) {
                chunks.push(allTokens.slice(i, i + 500));
            }

            // Send to all chunks
            const results = await Promise.all(
                chunks.map(chunk => this.sendMulticast(chunk, title, body, data))
            );

            // Aggregate results
            const totalSuccess = results.reduce((sum, r) => sum + (r.successCount || 0), 0);
            const totalFailure = results.reduce((sum, r) => sum + (r.failureCount || 0), 0);

            logger.info(`FCM bulk send: ${totalSuccess} success, ${totalFailure} failure`);

            return {
                success: true,
                successCount: totalSuccess,
                failureCount: totalFailure
            };
        } catch (error) {
            logger.error('FCM sendToUsers error:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Send multicast message to multiple tokens
     * @param {string[]} tokens - Array of FCM tokens
     * @param {string} title - Notification title
     * @param {string} body - Notification body
     * @param {Object} data - Additional data payload
     * @param {string} userId - Optional user ID for token cleanup
     * @returns {Promise<Object>} Send result
     */
    async sendMulticast(tokens, title, body, data = {}, userId = null) {
        try {
            if (!this.initialized) {
                return { success: false, reason: 'FCM not initialized' };
            }

            if (!tokens || tokens.length === 0) {
                return { success: false, reason: 'No tokens provided' };
            }

            // Sanitize data - all values must be strings
            const sanitizedData = this._sanitizeData(data);

            // Build message
            const message = {
                tokens,
                notification: {
                    title,
                    body
                },
                data: sanitizedData,
                android: {
                    priority: 'high',
                    notification: {
                        sound: 'default',
                        channelId: 'hospilink_notifications'
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default',
                            badge: parseInt(sanitizedData.unreadCount || '0')
                        }
                    }
                }
            };

            // Send message
            const response = await admin.messaging().sendEachForMulticast(message);

            logger.info(`FCM sent: ${response.successCount} success, ${response.failureCount} failure`);

            // Clean up invalid tokens
            if (userId && response.responses) {
                await this._cleanupInvalidTokens(userId, tokens, response.responses);
            }

            return {
                success: true,
                successCount: response.successCount,
                failureCount: response.failureCount
            };
        } catch (error) {
            logger.error('FCM sendMulticast error:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Sanitize data object - all values must be strings for FCM
     * @param {Object} data - Data object
     * @returns {Object} Sanitized data
     */
    _sanitizeData(data) {
        const sanitized = {};
        for (const [key, val] of Object.entries(data)) {
            if (val === null || val === undefined) {
                sanitized[key] = '';
            } else if (typeof val === 'object') {
                sanitized[key] = JSON.stringify(val);
            } else {
                sanitized[key] = String(val);
            }
        }
        return sanitized;
    }

    /**
     * Clean up invalid FCM tokens
     * @param {string} userId - User ID
     * @param {string[]} tokens - Array of tokens that were sent
     * @param {Array} responses - Array of send responses
     */
    async _cleanupInvalidTokens(userId, tokens, responses) {
        try {
            const invalidTokens = [];
            
            responses.forEach((resp, idx) => {
                if (!resp.success && resp.error) {
                    const errorCode = resp.error.code;
                    // Remove tokens that are invalid or unregistered
                    if (['messaging/invalid-registration-token', 
                         'messaging/registration-token-not-registered'].includes(errorCode)) {
                        invalidTokens.push(tokens[idx]);
                    }
                }
            });

            if (invalidTokens.length > 0) {
                await User.findByIdAndUpdate(userId, {
                    $pull: { fcmTokens: { token: { $in: invalidTokens } } }
                });
                logger.info(`Cleaned up ${invalidTokens.length} invalid FCM tokens for user ${userId}`);
            }
        } catch (error) {
            logger.error('Error cleaning up invalid tokens:', error.message);
        }
    }

    /**
     * Register FCM token for a user
     * @param {string} userId - User ID
     * @param {string} token - FCM token
     * @param {string} deviceId - Device ID
     * @param {string} platform - Platform (android/ios/web)
     * @returns {Promise<Object>} Result
     */
    async registerToken(userId, token, deviceId, platform = 'android') {
        try {
            // Remove old token for this device if exists
            await User.findByIdAndUpdate(userId, {
                $pull: { fcmTokens: { deviceId } }
            });

            // Add new token
            await User.findByIdAndUpdate(userId, {
                $push: {
                    fcmTokens: {
                        token,
                        deviceId,
                        platform,
                        updatedAt: new Date()
                    }
                }
            });

            logger.info(`FCM token registered for user ${userId}, device ${deviceId}`);
            return { success: true };
        } catch (error) {
            logger.error('Error registering FCM token:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Remove FCM token for a user
     * @param {string} userId - User ID
     * @param {string} token - FCM token to remove
     * @returns {Promise<Object>} Result
     */
    async removeToken(userId, token) {
        try {
            await User.findByIdAndUpdate(userId, {
                $pull: { fcmTokens: { token } }
            });

            logger.info(`FCM token removed for user ${userId}`);
            return { success: true };
        } catch (error) {
            logger.error('Error removing FCM token:', error.message);
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
module.exports = new FCMService();
