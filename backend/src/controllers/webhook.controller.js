const crypto = require("crypto");
const Document = require("../models/Document");
const cacheService = require('../services/cache.service');
const logger = require('../utils/logger');

/**
 * Verify the webhook token embedded in the request URL query string.
 *
 * IDFY does not support HMAC webhook signing, so we use a secret token
 * embedded in the callback URL that we register with them via email:
 *   POST /api/webhook/idfy-aadhaar?wt=<IDFY_WEBHOOK_TOKEN>
 *
 * Uses timingSafeEqual to prevent timing-based enumeration of the token.
 */
function verifyWebhookToken(receivedToken) {
    const expected = process.env.IDFY_WEBHOOK_TOKEN;

    if (!expected) {
        logger.error('IDFY_WEBHOOK_TOKEN is not configured — rejecting all webhook requests');
        return false;
    }

    if (!receivedToken) return false;

    // Pad to equal length before comparing to satisfy timingSafeEqual requirement
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(receivedToken);

    if (expectedBuf.length !== receivedBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

exports.handleAadhaarWebhook = async (req, res) => {
    try {
        // ── 1. Token verification ─────────────────────────────────────────────
        const receivedToken = req.query.wt;

        if (!verifyWebhookToken(receivedToken)) {
            logger.warn('Webhook rejected: invalid or missing token', { ip: req.ip });
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        // ── 2. Validate payload ───────────────────────────────────────────────
        const data = req.body;

        const requestId = data.reference_id;
        if (!requestId) {
            logger.warn('Webhook rejected: missing reference_id in payload');
            return res.status(400).json({ success: false, message: 'Invalid payload: missing reference_id' });
        }

        // ── 3. Update document ────────────────────────────────────────────────
        const result = await Document.updateOne(
            {
                "documents.verificationMeta.referenceId": requestId,
                "documents.documentType": "aadhaar-card"
            },
            {
                $set: {
                    "documents.$.verificationStatus": "auto-verified",
                    "documents.$.verificationMeta.status": "completed",
                    "documents.$.verificationMeta.rawResponse": data,
                    "documents.$.verificationMeta.verifiedAt": new Date(),
                    "documents.$.extractedData": data.parsed_details
                }
            }
        );

        // ── 4. Invalidate profile cache ───────────────────────────────────────
        if (result.modifiedCount > 0) {
            try {
                const docRecord = await Document.findOne({
                    "documents.verificationMeta.referenceId": requestId
                }).select('userId userRole').lean();

                if (docRecord) {
                    await cacheService.invalidateProfile(docRecord.userId.toString(), docRecord.userRole);
                }
            } catch (cacheErr) {
                logger.error(`Failed to invalidate profile cache after Aadhaar webhook: ${cacheErr.message}`);
            }
        }

        logger.info(`Aadhaar webhook processed: referenceId=${requestId}, modified=${result.modifiedCount}`);
        res.status(200).json({ success: true, message: 'Webhook processed successfully' });

    } catch (err) {
        logger.error(`Webhook error: ${err.message}`);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
